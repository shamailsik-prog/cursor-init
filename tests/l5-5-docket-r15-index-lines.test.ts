import { afterEach, describe, expect, it } from "vitest"
import { DOCKET_GENERATOR_FLAG_ENV } from "@/layers/L5_5_DocketGenerator/flag"
import { generateDocket } from "@/layers/L5_5_DocketGenerator/service"
import type { DocketFilingSet } from "@/layers/L5_5_DocketGenerator/types"
import petitionFixture from "@/layers/L5_5_DocketGenerator/fixtures/petition-odd.json"
import exhibitFixture from "@/layers/L5_5_DocketGenerator/fixtures/exhibits-forum.json"

const petition = petitionFixture as DocketFilingSet
const exhibits = exhibitFixture as DocketFilingSet
const cited = "The petitioner relies on Annexures A, B and C."
const inOrder = "The petitioner relies on Annexure A, then Annexure B and Annexure C."
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

describe("L5.5 R15 index lines", () => {
  const indexRefusals = [
    `LIST OF ANNEXURES\n1. A - Plaint\n2. B - Notice\n4. D - Receipt\n\n${inOrder}`,
    `LIST OF ANNEXURES\n1) A. Plaint\n2) D. Receipt\n\n${inOrder}`,
    `LIST OF ANNEXURES\n- A - Plaint\n- B - Notice\n- D - Receipt\n\n${inOrder}`,
    `LIST OF ANNEXURES\n* A. Plaint\n* D. Receipt\n\n${inOrder}`,
    `LIST OF ANNEXURES\nA - Plaint dated 01.01.2024\nD - Notice dated 02.02.2024\n\n${inOrder}`,
    `LIST OF ANNEXURES\nA - Plaint, see below\nD - Receipt, see below\n\n${inOrder}`,
    `LIST OF ANNEXURES\nA, as placed on record\nD, as placed on record\n\n${inOrder}`,
    `LIST OF ANNEXURES\nA refer para 2\nD refer para 2\n\n${inOrder}`,
    `LIST OF ANNEXURE\nA: Plaint\nD: Receipt\n\n${inOrder}`,
    `LIST OF ENCLOSURES\nA - Plaint\nD - Receipt\n\n${inOrder}`,
    `INDEX\nA - Plaint\nB - Notice\nD - Receipt\n\n${inOrder}`,
    `list of annexures\nA: Plaint\nD: Receipt\n\n${inOrder}`,
    `| A | Plaint |\n| B | Notice |\n| D | Receipt |\n\n${inOrder}`,
    `| Annexure | Description |\n| D | Bank statement |\n\n${inOrder}`,
  ]

  it.each(indexRefusals)("refuses an unfiled label on an index line: %s", async (body) => {
    const result = await resultFor(petition, body)
    expect(result.ok, body).toBe(false)
    expect(result.pdf, body).toBeNull()
    expect(result.docx, body).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("D")), body).toBe(true)
  })

  const exhibitLines = [
    `LIST OF EXHIBITS\nDocument No. P-9\n\n${proved}`,
    `LIST OF EXHIBITS\ndeed/P/9\n\n${proved}`,
    `LIST OF EXHIBITS\nsale-deed/P-9\n\n${proved}`,
    `LIST OF EXHIBITS\ndocument P-9\n\n${proved}`,
    `${proved} Document No. P-9.`,
    `${proved} deed/P/9.`,
    `${proved} sale-deed/P-9.`,
    `${proved} document P-9.`,
    `${proved} Exh. P-1/A.`,
    `${proved} P-1A.`,
    `${proved} P-1(a).`,
  ]

  it.each(exhibitLines)("refuses an unfiled exhibit mark: %s", async (body) => {
    const result = await resultFor(withThirdExhibit(), body)
    expect(result.ok, body).toBe(false)
    expect(result.pdf, body).toBeNull()
    expect(result.docx, body).toBeNull()
    expect(result.queue.some((entry) => entry.code === "ref_unresolved"), body).toBe(true)
  })

  const continuations = [
    "Annexures A, B, C\n\nand D are filed.",
    `${cited}\n\nand D are filed.`,
  ]

  it.each(continuations)("refuses a label after a blank line: %s", async (body) => {
    const result = await resultFor(petition, body)
    expect(result.ok, body).toBe(false)
    expect(result.pdf, body).toBeNull()
    expect(result.docx, body).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("D")), body).toBe(true)
  })

  const mutants = [
    `${cited} SCHEDULE OF ANNEXURES: A, B, C, D.`,
    `${cited} The annexure is D.`,
    `${cited} The relevant annexure is D.`,
    `${cited} Annexures A, B, etc. and D are filed.`,
  ]

  it.each(mutants)("refuses the mutant kill input: %s", async (body) => {
    const result = await resultFor(petition, body)
    expect(result.ok, body).toBe(false)
    expect(result.pdf, body).toBeNull()
    expect(result.docx, body).toBeNull()
    expect(result.queue.some((entry) => entry.code === "ref_unresolved"), body).toBe(true)
  })

  const generated = [
    `${cited} A.D. 2020.`,
    `${cited} The order in C.P. No. D-1234 of 2023 is impugned.`,
    `${cited} Suit No. 12 of 2020 is pending.`,
    `${cited} See Annexure A - u/s 80 CPC.`,
    `${proved} Exh. P-1 is the plaint in Suit No. D-12 of 2020.`,
  ]

  it.each(generated)("generates a case number, a year, or a section cite: %s", async (body) => {
    const filing = body.includes("Exh. P-1") ? withThirdExhibit() : petition
    const result = await resultFor(filing, body)
    expect(result.ok, body).toBe(true)
    expect(result.pdf, body).not.toBeNull()
    expect(result.docx, body).not.toBeNull()
    expect(result.queue, body).toEqual([])
  })

  const described = (heading: string) => `${heading}\nC - Plaint\nB - Notice\nA - Receipt`

  const pureIndexes = [
    "LIST OF ANNEXURES\nC - Plaint\nB - Notice\nA - Receipt",
    described("**LIST OF ANNEXURES**"),
    described("(LIST OF ANNEXURES)"),
    described('"LIST OF ANNEXURES"'),
    described("1 LIST OF ANNEXURES"),
    described("- LIST OF ANNEXURES"),
    described("LIST-OF-ANNEXURES"),
    described("LIST OF\nANNEXURES"),
    described("list of annexures"),
    described("INDEX OF ANNEXURES"),
    described("LIST OF DOCUMENTS"),
    described("*LIST OF ANNEXURES*"),
    described("__LIST OF ANNEXURES__"),
    described("LIST OF ANNEXURES:"),
    described("Index of annexures"),
    "LIST OF ANNEXURES\nC. Plaint\nB. Notice\nA. Receipt",
    described("INDEX OF DOCUMENTS"),
    "LIST OF ANNEXURES: C, B and A.",
  ]

  it.each(pureIndexes)("leaves a reversed pure index out of the order check: %s", async (body) => {
    const result = await resultFor(petition, body)
    expect(result.ok, body).toBe(true)
    expect(result.pdf, body).not.toBeNull()
    expect(result.docx, body).not.toBeNull()
    expect(result.queue.some((entry) => entry.code === "order_unresolved"), body).toBe(false)
  })
})
