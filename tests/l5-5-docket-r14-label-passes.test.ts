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

describe("L5.5 R14 label passes", () => {
  const slotRefusals = [
    "Annexure NAB is the notice.",
    "Exhibit FIR is the report.",
    "Mark SHO is the officer.",
    "ANNEXURE DEFGH is the deed.",
    "Annexure FIR-1 is the copy.",
    "Annexures A, B, C and FIR are filed.",
    "See Annexures on record, Ref. D.",
    "See Annexures on record, Ibid. D.",
    "See Annexures on record, Incl. D.",
    "See Annexures on record, Op. cit. D.",
    "See Annexure A - Annex. D.",
    "Annexures filed herewith, Ref. D.",
    "See Annexures on record. D.",
    "Annexures filed herewith, i.e. D.",
    "See Annexures on record, ibid. D.",
    "Refer to D.",
    "Reliance is placed on D.",
    "See Annexures filed herewith DE.",
    "Annexures on record É.",
    "See Annexure A - Plaint É.",
    "Annexures A, B, C\n\nD are filed.",
    "Annexure A (D) is the deed.",
    "Annexures A, B, C and, D are filed.",
    "See Annexures on record, cf. DEFGH.",
    "See Annexure C i.e. D.",
    "Annexure CrPC is the notice.",
    "Annexures A, B, C etc., D are filed.",
    "Annexures filed herewith À.",
    "The deed is marked D.",
    "| Annexure | D | Bank statement |",
    "Annexure | D is the deed.",
  ]

  it.each(slotRefusals)("refuses a label token: %s", async (sentence) => {
    const result = await resultFor(petition, `${cited} ${sentence}`)
    expect(result.ok, sentence).toBe(false)
    expect(result.pdf, sentence).toBeNull()
    expect(result.docx, sentence).toBeNull()
    expect(result.queue.some((entry) => entry.code === "ref_unresolved"), sentence).toBe(true)
  })

  const exotic = ["À", "Á", "Â", "Ä", "Å", "Æ", "Ç", "É", "È", "Ê", "Ë", "Í", "Î", "Ï", "Ñ", "Ó", "Ö", "Ø", "Ú", "Ü", "Ý"]

  it.each(exotic)("refuses a non-A-Z letter in a slot: %s", async (letter) => {
    const sentence = `Annexures filed herewith ${letter}.`
    const result = await resultFor(petition, `${cited} ${sentence}`)
    expect(result.ok, letter).toBe(false)
    expect(result.pdf, letter).toBeNull()
    expect(result.docx, letter).toBeNull()
    expect(result.queue.some((entry) => entry.code === "ref_unresolved"), letter).toBe(true)
  })

  const headings = [
    `LIST OF ANNEXURES: A, B, C, D. ${inOrder}`,
    `LIST OF ANNEXURES\nA: Plaint\nB: Notice\nD: Receipt\n\n${inOrder}`,
    `LIST OF ANNEXURES\nA - Certified copy of the plaint\nD - Notice dated 1 January 2024\n\n${inOrder}`,
    `LIST OF ANNEXURES\nA - Plaint\nB - Notice\nD - Receipt\n\n${inOrder}`,
  ]

  it.each(headings)("refuses an unfiled heading label: %s", async (body) => {
    const result = await resultFor(petition, body)
    expect(result.ok, body).toBe(false)
    expect(result.pdf, body).toBeNull()
    expect(result.docx, body).toBeNull()
    expect(result.queue.some((entry) => entry.code === "ref_unresolved"), body).toBe(true)
  })

  const orders = [
    "LIST OF ANNEXURES: Refer to Annexure C, see Annexure B and Annexure A.",
    "See C, see B, see A.",
    "Index of documents: refer to C, see B and A.",
    "LIST OF EXHIBITS: See P-1, see P-3 and refer to P-2.",
    "LIST OF ANNEXURES\nRefer to Annexure C, see Annexure B and Annexure A.",
    "See C, see B, see A",
  ]

  it.each(orders)("refuses narrative order: %s", async (body) => {
    const filing = body.startsWith("LIST OF EXHIBITS") ? withThirdExhibit() : petition
    const result = await resultFor(filing, body)
    expect(result.ok, body).toBe(false)
    expect(result.pdf, body).toBeNull()
    expect(result.docx, body).toBeNull()
    expect(result.queue.some((entry) => entry.code === "order_unresolved"), body).toBe(true)
  })

  const exhibitRefusals = [
    "The witness proved P-1, P-2 and then P-3. The witness relies on Exh. P-9, Block 5 deed.",
    "The witness proved P-1, P-2 and then P-3. Exh. No. P-9 of 2024.",
    "The witness proved P-1, P-2 and then P-3. Document No. P-9.",
    "The witness proved P-1, P-2 and then P-3. deed/P/9.",
    "The witness proved P-1, P-2 and then P-3. sale-deed/P-9.",
  ]

  it.each(exhibitRefusals)("refuses an unfiled exhibit mark: %s", async (body) => {
    const result = await resultFor(withThirdExhibit(), body)
    expect(result.ok, body).toBe(false)
    expect(result.pdf, body).toBeNull()
    expect(result.docx, body).toBeNull()
    expect(result.queue.some((entry) => entry.code === "ref_unresolved"), body).toBe(true)
  })

  const agencies = [
    "WAPDA", "LHC", "IHC", "PHC", "BHC", "KMC", "NHA", "PIA", "DIG", "IGP", "ASI", "CAA", "ATC", "HEC",
    "SI", "DC", "AIG", "SP", "PS", "KE", "SSGC", "SNGPL", "NADRA", "OC",
  ]

  const generated = [
    ...agencies.map((name) => `The notice was issued by ${name}.`),
    "The rule in PLD 2010 SC 1 decides the point.",
    "cf. the plaint.",
    "e.g. the deed.",
    "The café is on the record.",
    "SEE ANNEXURES ON RECORD.",
    "The annexures are filed, etc.",
    "Annexures A, B, C, etc. are filed.",
    "cf. DEFGH.",
    "annex land",
    "mark time",
    "Mark all pages",
    "ex wife",
    "ex post facto",
    "doc fees",
    "doc says",
    "marked down",
    "marked late",
    "The annexure has been filed.",
    "enc key",
    "The annexure, if any,",
    "annexure may/can",
    "Annexure A and its translation",
    "Doc no 5",
    "annexures have been served",
    "annexures above",
    "Annexures thereto",
    "mark the date",
    "doc review",
    "annex the land",
    `${cited}\nLIST OF ANNEXURES\nA: Plaint\nB: Notice\nC: Vakalatnama\n${inOrder}`,
  ]

  it.each(["Esp. D.", "Etc. D."])("names the bare capital after an abbreviation: %s", async (sentence) => {
    const result = await resultFor(petition, `${cited} ${sentence}`)
    expect(result.ok, sentence).toBe(false)
    expect(result.pdf, sentence).toBeNull()
    expect(result.docx, sentence).toBeNull()
    expect(result.queue.some((entry) => entry.code === "unfiled_label" && entry.detail === 'unfiled label "D"'), sentence).toBe(true)
  })

  it.each(generated)("generates text that is not a label token: %s", async (sentence) => {
    const body = sentence.startsWith(cited) ? sentence : `${cited} ${sentence}`
    const result = await resultFor(petition, body)
    expect(result.ok, sentence).toBe(true)
    expect(result.pdf, sentence).not.toBeNull()
    expect(result.docx, sentence).not.toBeNull()
    expect(result.queue, sentence).toEqual([])
  })
})
