import { afterEach, describe, expect, it } from "vitest"
import { DOCKET_GENERATOR_FLAG_ENV } from "@/layers/L5_5_DocketGenerator/flag"
import { generateDocket } from "@/layers/L5_5_DocketGenerator/service"
import type { DocketFilingSet } from "@/layers/L5_5_DocketGenerator/types"
import petitionFixture from "@/layers/L5_5_DocketGenerator/fixtures/petition-odd.json"
import exhibitFixture from "@/layers/L5_5_DocketGenerator/fixtures/exhibits-forum.json"

const petition = petitionFixture as DocketFilingSet
const exhibits = exhibitFixture as DocketFilingSet
const cited = "The petitioner relies on Annexures A, B and C."

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

describe("L5.5 label-slot grammar", () => {
  const refusals = [
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
    "Annexure FIR-1 is the copy.",
    "See Annexure A - Plaint É.",
  ]

  it("refuses Annexure PPC when relies reaches the head", async () => {
    const result = await resultFor(petition, "Annexure A, Annexure B and Annexure C are on the record. The petitioner also relies on Annexure PPC.")
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.docx).toBeNull()
    expect(result.queue.some((entry) => entry.code === "ref_unresolved" && entry.detail.includes("PPC"))).toBe(true)
  })

  it.each(refusals)("refuses a label slot: %s", async (sentence) => {
    const result = await resultFor(petition, `${cited} ${sentence}`)
    expect(result.ok, sentence).toBe(false)
    expect(result.pdf, sentence).toBeNull()
    expect(result.docx, sentence).toBeNull()
    expect(result.queue.some((entry) => entry.code === "ref_unresolved"), sentence).toBe(true)
  })

  const orders = [
    "LIST OF ANNEXURES: Refer to Annexure C, see Annexure B and Annexure A.",
    "See C, see B, see A.",
    "Index of documents: refer to C, see B and A.",
    "LIST OF ANNEXURES\nRefer to Annexure C, see Annexure B and Annexure A.",
    "**LIST OF ANNEXURES**\nRefer to Annexure C, see Annexure B and Annexure A.",
    "List of annexures - refer to Annexure C or Annexure B and then Annexure A.",
  ]

  it.each(orders)("refuses narrative order: %s", async (body) => {
    const result = await resultFor(petition, body)
    expect(result.ok, body).toBe(false)
    expect(result.pdf, body).toBeNull()
    expect(result.docx, body).toBeNull()
    expect(result.queue.some((entry) => entry.code === "order_unresolved"), body).toBe(true)
  })

  it("refuses an exhibit heading whose remainder is narrative", async () => {
    const bodies = [
      "LIST OF EXHIBITS: See P-1, see P-3 and refer to P-2.",
      "LIST OF EXHIBITS\u0085The witness proved P-1, P-3 and then P-2.",
    ]
    for (const body of bodies) {
      const result = await resultFor(withThirdExhibit(), body)
      expect(result.ok, JSON.stringify(body)).toBe(false)
      expect(result.pdf, JSON.stringify(body)).toBeNull()
      expect(result.docx, JSON.stringify(body)).toBeNull()
      expect(result.queue.some((entry) => entry.code === "order_unresolved"), JSON.stringify(body)).toBe(true)
    }
  })

  it("refuses a pipe label after the caps opener", async () => {
    const body = `${cited} ANNEXURES:\n\nA - Plaint\n\nB - Notice\n\nC - Vakalatnama\n\nANNEXURE A | D IS THE DEED.`
    const result = await resultFor(petition, body)
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.docx).toBeNull()
    expect(result.queue.some((entry) => entry.code === "ref_unresolved")).toBe(true)
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
    "cf. DEFGH.",
    "Annexures relate to the FIR.",
    "Annexures relate to section 302 PPC.",
    "The annexures are governed by the CPC.",
    "The annexures were produced before the SHO.",
    "The annexures were sent to NHS Legal.",
    "The annexures were seized under the CrPC.",
    "THE ANNEXURES ARE TRUE COPIES.",
    "ANNEXURES RELATE TO THE FIR.",
  ]

  it.each(["Esp. D.", "Etc. D."])("names the bare capital after an abbreviation: %s", async (sentence) => {
    const result = await resultFor(petition, `${cited} ${sentence}`)
    expect(result.ok, sentence).toBe(false)
    expect(result.pdf, sentence).toBeNull()
    expect(result.docx, sentence).toBeNull()
    expect(result.queue.some((entry) => entry.code === "unfiled_label" && entry.detail === 'unfiled label "D"'), sentence).toBe(true)
  })

  it.each(generated)("generates text outside a label slot: %s", async (sentence) => {
    const result = await resultFor(petition, `${cited} ${sentence}`)
    expect(result.ok, sentence).toBe(true)
    expect(result.pdf, sentence).not.toBeNull()
    expect(result.docx, sentence).not.toBeNull()
    expect(result.queue, sentence).toEqual([])
  })

  it("generates a heading list and an in-order body", async () => {
    const body = `${cited}\nLIST OF ANNEXURES\nA: Plaint\nB: Notice\nC: Vakalatnama\nThe petitioner relies on Annexure A, then Annexure B and Annexure C.`
    const result = await resultFor(petition, body)
    expect(result.ok).toBe(true)
    expect(result.pdf).not.toBeNull()
    expect(result.docx).not.toBeNull()
    expect(result.queue).toEqual([])
  })
})
