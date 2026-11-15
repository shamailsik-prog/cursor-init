import { spawnSync } from "node:child_process"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { unzipSync, strFromU8 } from "fflate"
import { PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib"
import { afterEach, describe, expect, it } from "vitest"
import documentTypes from "@/data/documentTypes.json"
import { classifyAnnexureRule, knownAnnexureRules } from "@/layers/L5_5_DocketGenerator/rules"
import { disable, healthCheck } from "@/layers/L5_5_DocketGenerator/health"
import { docketGeneratorRoute } from "@/layers/L5_5_DocketGenerator/routes"
import { DocketGeneratorExtension } from "@/layers/L5_5_DocketGenerator/ui.extension"
import {
  DOCKET_GENERATOR_FLAG,
  DOCKET_GENERATOR_FLAG_ENV,
  isDocketGeneratorEnabled,
} from "@/layers/L5_5_DocketGenerator/flag"
import { resolveFilingSet } from "@/layers/L5_5_DocketGenerator/ambiguity"
import { assignedCitation } from "@/layers/L5_5_DocketGenerator/references"
import { contentBox, pagePoints, planDocket, WRAP_SLACK, wrapParagraph } from "@/layers/L5_5_DocketGenerator/layout"
import { TINOS_REGULAR_WIDTHS, TINOS_UNITS_PER_EM, tnrWidth } from "@/layers/L5_5_DocketGenerator/metrics"
import { generateDocket } from "@/layers/L5_5_DocketGenerator/service"
import { FIXED_DOCKET_TIMESTAMP } from "@/layers/L5_5_DocketGenerator/pdf"
import type { DocketFilingSet } from "@/layers/L5_5_DocketGenerator/types"
import type { FilingAnnexureManifestItem } from "@/platform/spine/store"
import petitionFixture from "@/layers/L5_5_DocketGenerator/fixtures/petition-odd.json"
import applicationFixture from "@/layers/L5_5_DocketGenerator/fixtures/application-legal.json"
import enclosureFixture from "@/layers/L5_5_DocketGenerator/fixtures/enclosures-a4.json"
import impugnedFixture from "@/layers/L5_5_DocketGenerator/fixtures/impugned-single.json"
import ambiguousFixture from "@/layers/L5_5_DocketGenerator/fixtures/ambiguous-scheme.json"
import exhibitFixture from "@/layers/L5_5_DocketGenerator/fixtures/exhibits-forum.json"

const petition = petitionFixture as DocketFilingSet
const application = applicationFixture as DocketFilingSet
const enclosures = enclosureFixture as DocketFilingSet
const impugned = impugnedFixture as DocketFilingSet
const ambiguous = ambiguousFixture as DocketFilingSet
const exhibits = exhibitFixture as DocketFilingSet

function enableFlag(): void {
  process.env[DOCKET_GENERATOR_FLAG_ENV] = "true"
}

afterEach(() => {
  delete process.env[DOCKET_GENERATOR_FLAG_ENV]
})

function asMetadata(value: DocketFilingSet["annexures"][number]["metadata"]): FilingAnnexureManifestItem {
  return value
}

async function pdfPages(bytes: Uint8Array): Promise<{ width: number; height: number; texts: string[] }> {
  const pdf = await PDFDocument.load(bytes)
  const texts: string[] = []
  for (const page of pdf.getPages()) {
    const contents = page.node.Contents()
    if (!contents) {
      texts.push("")
      continue
    }
    const refs = "size" in contents ? Array.from({ length: contents.size() }, (_, index) => contents.get(index)) : [contents]
    let text = ""
    for (const ref of refs) {
      const stream = pdf.context.lookup(ref)
      if (!(stream instanceof PDFRawStream)) continue
      const decoded = new TextDecoder().decode(decodePDFRawStream(stream).decode())
      for (const match of decoded.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
        const hex = match[1] ?? ""
        let word = ""
        for (let index = 0; index < hex.length; index += 2) {
          word += String.fromCharCode(Number.parseInt(hex.slice(index, index + 2), 16))
        }
        text += word
      }
    }
    texts.push(text)
  }
  const first = pdf.getPages()[0]
  return {
    width: first?.getWidth() ?? 0,
    height: first?.getHeight() ?? 0,
    texts,
  }
}

function docxPages(bytes: Uint8Array): { width: number; height: number; texts: string[]; core: string } {
  const files = unzipSync(bytes)
  const document = strFromU8(files["word/document.xml"] ?? new Uint8Array())
  const core = strFromU8(files["docProps/core.xml"] ?? new Uint8Array())
  const size = document.match(/<w:pgSz[^>]*w:w="(\d+)"[^>]*w:h="(\d+)"/) ?? document.match(/w:h="(\d+)"[^>]*w:w="(\d+)"/)
  const texts = docxSections(bytes).map((section) => section.text)
  const width = size ? Number(size[1]) : 0
  const height = size ? Number(size[2]) : 0
  return { width, height, texts, core }
}

function indexRows(text: string): Array<{ label: string; page: number }> {
  return [...text.matchAll(/(Annexure [A-Z]|Enclosure \d+|P-\d+) \| [^|]+ \| (\d+)/g)].map((match) => ({
    label: match[1] ?? "",
    page: Number(match[2]),
  }))
}

describe("L5.5 docket generator flag", () => {
  it("stays off unless the env value is true", () => {
    expect(isDocketGeneratorEnabled()).toBe(false)
    process.env[DOCKET_GENERATOR_FLAG_ENV] = "false"
    expect(isDocketGeneratorEnabled()).toBe(false)
    process.env[DOCKET_GENERATOR_FLAG_ENV] = "yes"
    expect(isDocketGeneratorEnabled()).toBe(false)
    process.env[DOCKET_GENERATOR_FLAG_ENV] = " TRUE "
    expect(isDocketGeneratorEnabled()).toBe(true)
    expect(healthCheck()).toEqual({ ok: true, flag: DOCKET_GENERATOR_FLAG, enabled: true })
    expect(disable()).toEqual({ unsubscribed: true, dataIntact: true })
    expect(DocketGeneratorExtension()).toBeNull()
  })

  it("refuses bytes while the flag is off", async () => {
    const result = await generateDocket(petition)
    expect(result.enabled).toBe(false)
    expect(result.ok).toBe(false)
    expect(result.queue).toEqual([])
    expect(result.pdf).toBeNull()
    expect(result.docx).toBeNull()
    expect(await docketGeneratorRoute(petition)).toEqual(result)
  })
})

describe("L5.5 court-format docket", () => {
  it("uses the existing annexure metadata shape and the seeded petition rule", () => {
    const metadata = asMetadata(petition.annexures[0]!.metadata)
    expect(metadata.artifactId).toBe("ann-a")
    expect(documentTypes.types.some((type) => type.annexureRule === petition.annexureRule)).toBe(true)
    expect(documentTypes.types.some((type) => type.annexureRule === application.annexureRule)).toBe(true)
    expect(documentTypes.types.some((type) => type.annexureRule === enclosures.annexureRule)).toBe(true)
    expect(documentTypes.types.some((type) => type.annexureRule === impugned.annexureRule)).toBe(true)
    expect(documentTypes.types.some((type) => type.annexureRule === ambiguous.annexureRule)).toBe(true)
    expect(documentTypes.types.some((type) => type.annexureRule === exhibits.annexureRule)).toBe(true)
  })

  it("classifies every seeded annexure rule and no other", () => {
    const seen = new Set<string>()
    for (const type of documentTypes.types) {
      seen.add(type.annexureRule)
      const classified = classifyAnnexureRule(type.annexureRule)
      expect(classified, type.id).not.toBeNull()
      if (!classified) continue
      if (type.annexureRule.includes("odd pagination")) {
        expect(classified).toMatchObject({ pageSize: "legal", pagination: "odd", scheme: { kind: "letters", requireReferenceOrder: true } })
      } else if (type.annexureRule.startsWith("Annexures A, B, C")) {
        expect(classified).toMatchObject({ pageSize: "legal", pagination: "odd", scheme: { kind: "letters", requireReferenceOrder: false } })
      } else if (type.annexureRule.startsWith("Certified copy")) {
        expect(classified).toMatchObject({ pageSize: "legal", pagination: "odd", scheme: { kind: "single-a" } })
      } else if (type.annexureRule.includes("or P/1")) {
        expect(classified.scheme.kind).toBe("ambiguous")
        expect(classified.pageSize).toBe("legal")
      } else if (type.annexureRule.includes("or R/1")) {
        expect(classified.scheme.kind).toBe("ambiguous")
      } else if (type.annexureRule.startsWith("Schedules")) {
        expect(classified.scheme.kind).toBe("ambiguous")
        expect(classified.pagination).toBe("sequential")
      } else if (type.annexureRule.startsWith("Enclosures")) {
        expect(classified).toMatchObject({ pageSize: "a4", pagination: "sequential", scheme: { kind: "enclosures", requireReferenceOrder: true } })
      } else if (type.annexureRule.startsWith("Exhibits")) {
        expect(classified).toMatchObject({ pageSize: "forum", pagination: "follow-page-size", scheme: { kind: "manual", requireReferenceOrder: true } })
      } else if (type.annexureRule.startsWith("Sources listed") || type.annexureRule.startsWith("Attendance") || type.annexureRule.startsWith("Source document")) {
        expect(classified.scheme.kind).toBe("manual")
        expect(classified.pageSize).toBe("a4")
        expect(classified.pagination).toBe("sequential")
      } else {
        throw new Error(`unclassified seed rule: ${type.annexureRule}`)
      }
    }
    expect(seen.size).toBe(11)
    expect(knownAnnexureRules().slice().sort()).toEqual([...seen].sort())
  })

  it("builds a legal odd-paginated docket whose index matches annexure starts", async () => {
    enableFlag()
    const result = await generateDocket(petition)
    expect(result.ok).toBe(true)
    expect(result.queue).toEqual([])
    expect(result.pageCount).toBe(10)
    expect(result.index).toEqual([
      { label: "Annexure A", description: "Impugned order dated 12-06-2026", physicalPage: 5, printedPage: 5 },
      { label: "Annexure B", description: "Notice dated 01-07-2026", physicalPage: 7, printedPage: 7 },
      { label: "Annexure C", description: "Vakalatnama", physicalPage: 9, printedPage: 9 },
    ])
    const pdf = await pdfPages(result.pdf!)
    const docx = docxPages(result.docx!)
    expect(pdf.texts).toHaveLength(10)
    expect(docx.texts).toHaveLength(10)
    expect(pdf.width).toBe(612)
    expect(pdf.height).toBe(1008)
    expect(docx.width).toBe(12240)
    expect(docx.height).toBe(20160)
    const pdfIndex = indexRows(pdf.texts[2] ?? "")
    const docxIndex = indexRows(docx.texts[2] ?? "")
    expect(pdfIndex.map((row) => row.label)).toEqual(["Annexure A", "Annexure B", "Annexure C"])
    expect(docxIndex).toEqual(pdfIndex)
    for (const row of pdfIndex) {
      expect(row.page % 2).toBe(1)
      expect(pdf.texts[row.page - 1]).toContain(row.label.replace("Annexure ", "ANNEXURE "))
      expect(docx.texts[row.page - 1]).toContain(row.label.replace("Annexure ", "ANNEXURE "))
    }
    for (let page = 1; page < pdf.texts.length; page += 2) {
      expect(pdf.texts[page]?.replace(/\s/g, "")).toBe("")
      expect(docx.texts[page]?.replace(/\s/g, "")).toBe("")
    }
    const created = (await PDFDocument.load(result.pdf!)).getCreationDate()
    expect(created?.toISOString()).toBe(FIXED_DOCKET_TIMESTAMP)
    expect(docx.core).toContain("2026-01-01T00:00:00Z")
  })

  it("keeps the next annexure on an odd page after a multi-leaf annexure", async () => {
    enableFlag()
    const filing: DocketFilingSet = {
      ...petition,
      annexures: petition.annexures.map((annexure, index) =>
        index === 1
          ? {
              ...annexure,
              body: Array.from({ length: 80 }, () => "The record continues on this leaf of the paper-book.").join("\n"),
            }
          : annexure,
      ),
    }
    const result = await generateDocket(filing)
    expect(result.ok).toBe(true)
    const pdf = await pdfPages(result.pdf!)
    const docx = docxPages(result.docx!)
    expect(pdf.texts).toHaveLength(result.pageCount ?? 0)
    expect(docx.texts).toHaveLength(pdf.texts.length)
    const rows = indexRows(pdf.texts.find((text) => text.includes("INDEX OF ANNEXURES")) ?? "")
    expect(rows.map((row) => row.label)).toEqual(["Annexure A", "Annexure B", "Annexure C"])
    expect(rows[1]!.page).toBeGreaterThan(rows[0]!.page)
    expect(rows[2]!.page).toBeGreaterThan(rows[1]!.page + 2)
    for (const row of rows) {
      expect(row.page % 2).toBe(1)
      expect(pdf.texts[row.page - 1]).toContain(`ANNEXURE ${row.label.slice(-1)}`)
      expect(docx.texts[row.page - 1]).toContain(`ANNEXURE ${row.label.slice(-1)}`)
    }
    const between = pdf.texts.slice(rows[1]!.page, rows[2]!.page - 1).join("")
    expect(between).toContain("paper-book")
  })

  it("paginates a legal-size application on odd numbers without body citations", async () => {
    enableFlag()
    const ready = {
      ...application,
      annexures: application.annexures.map((annexure) => ({
        ...annexure,
        metadata: { ...annexure.metadata, status: "ready" as const },
      })),
    }
    const result = await generateDocket(ready)
    expect(result.ok).toBe(true)
    expect(result.index?.map((entry) => entry.label)).toEqual(["Annexure A", "Annexure B"])
    expect(result.index?.every((entry) => entry.physicalPage % 2 === 1)).toBe(true)
    const pdf = await pdfPages(result.pdf!)
    expect(pdf.width).toBe(612)
    expect(pdf.height).toBe(1008)
    expect(pdf.texts[result.index![0]!.physicalPage - 1]).toContain("ANNEXURE A")
    expect(pdf.texts[result.index![1]!.physicalPage - 1]).toContain("ANNEXURE B")
  })

  it("numbers a single impugned order as Annexure A", async () => {
    enableFlag()
    const result = await generateDocket(impugned)
    expect(result.ok).toBe(true)
    expect(result.index).toEqual([
      { label: "Annexure A", description: "Impugned order", physicalPage: 5, printedPage: 5 },
    ])
    const pdf = await pdfPages(result.pdf!)
    expect(pdf.texts[4]).toContain("ANNEXURE A")
  })

  it("uses sequential A4 pages for enclosures", async () => {
    enableFlag()
    const result = await generateDocket(enclosures)
    expect(result.ok).toBe(true)
    expect(result.pageCount).toBe(4)
    expect(result.index).toEqual([
      { label: "Enclosure 1", description: "Challan", physicalPage: 3, printedPage: 3 },
      { label: "Enclosure 2", description: "Order", physicalPage: 4, printedPage: 4 },
    ])
    const pdf = await pdfPages(result.pdf!)
    const docx = docxPages(result.docx!)
    expect(pdf.width).toBeCloseTo(595.28, 2)
    expect(pdf.height).toBeCloseTo(841.89, 2)
    expect(docx.width).toBe(11906)
    expect(docx.height).toBe(16838)
    expect(pdf.texts).toHaveLength(4)
    expect(docx.texts).toHaveLength(4)
    expect(pdf.texts[2]).toContain("ENCLOSURE 1")
    expect(pdf.texts[3]).toContain("ENCLOSURE 2")
    expect(indexRows(pdf.texts[1] ?? "")).toEqual([
      { label: "Enclosure 1", page: 3 },
      { label: "Enclosure 2", page: 4 },
    ])
  })

  it("uses a supplied forum page size and the assigned exhibit marks", async () => {
    enableFlag()
    const result = await generateDocket(exhibits)
    expect(result.ok).toBe(true)
    expect(result.index?.map((entry) => [entry.label, entry.physicalPage])).toEqual([
      ["P-1", 5],
      ["P-2", 7],
    ])
    const pdf = await pdfPages(result.pdf!)
    expect(pdf.width).toBe(612)
    expect(pdf.texts[4]).toContain("P-1")
    expect(pdf.texts[6]).toContain("P-2")
  })

  it("is byte-stable for the same filing set", async () => {
    enableFlag()
    const first = await generateDocket(petition)
    const second = await generateDocket(petition)
    expect(Buffer.from(first.pdf!).equals(Buffer.from(second.pdf!))).toBe(true)
    expect(Buffer.from(first.docx!).equals(Buffer.from(second.docx!))).toBe(true)
  })

  it("freezes document timestamps and leaves an ISO timestamp in the filing text", async () => {
    enableFlag()
    const stamp = "2026-11-14T10:30:00Z"
    const filing: DocketFilingSet = {
      ...petition,
      draft: { body: `${petition.draft.body} The notice was served at ${stamp}.` },
    }
    const first = await generateDocket(filing)
    const second = await generateDocket(filing)
    expect(first.ok).toBe(true)
    expect(Buffer.from(first.docx!).equals(Buffer.from(second.docx!))).toBe(true)
    const files = unzipSync(first.docx!)
    const core = strFromU8(files["docProps/core.xml"] ?? new Uint8Array())
    const document = strFromU8(files["word/document.xml"] ?? new Uint8Array())
    expect(core).toContain("2026-01-01T00:00:00Z")
    expect(core).not.toContain(stamp)
    expect(document).toContain(stamp)
    const pdf = await pdfPages(first.pdf!)
    expect(pdf.texts.join("\n")).toContain(stamp)
  })
})

describe("L5.5 ambiguity queue", () => {
  it("keeps assigned labels on an ambiguous scheme and queues a citation outside that set", async () => {
    enableFlag()
    const labeled = ambiguous.annexures.map((annexure, index) => ({
      ...annexure,
      assignedLabel: index === 0 ? "P/1" : "P/2",
    }))
    const accepted = await generateDocket({
      ...ambiguous,
      draft: { body: "The plaintiff relies on P/1 and then P/2." },
      annexures: labeled,
    })
    expect(accepted.ok).toBe(true)
    expect(accepted.index?.map((entry) => entry.label)).toEqual(["P/1", "P/2"])

    const dangling = await generateDocket({
      ...ambiguous,
      draft: { body: "The plaintiff relies on P/99." },
      annexures: labeled,
    })
    expect(dangling.ok).toBe(false)
    expect(dangling.pdf).toBeNull()
    expect(dangling.docx).toBeNull()
    expect(dangling.queue).toEqual([
      expect.objectContaining({
        code: "ref_unresolved",
        artifactId: null,
        detail: "body cites P/99, which is not an annexure in this filing set",
      }),
    ])
  })

  it("queues an unresolved series and refuses bytes", async () => {
    enableFlag()
    const result = await generateDocket(ambiguous)
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.docx).toBeNull()
    expect(result.queue.map((entry) => entry.code)).toContain("label_unresolved")
    expect(result.queue.some((entry) => entry.detail.includes("P/1"))).toBe(true)
  })

  it("queues a forum page size that was not supplied", async () => {
    enableFlag()
    const { forumPageSize: _size, ...rest } = exhibits
    const result = await generateDocket(rest)
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.docx).toBeNull()
    expect(result.queue).toEqual([
      expect.objectContaining({ code: "ref_unresolved", artifactId: null }),
    ])
  })

  it("queues an order that does not match the filing set and does not reorder", async () => {
    enableFlag()
    const filing: DocketFilingSet = {
      ...petition,
      annexures: petition.annexures.map((annexure, index) => ({ ...annexure, order: index === 0 ? 2 : 1 })),
    }
    const result = await generateDocket(filing)
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.code === "order_unresolved")).toBe(true)
  })

  it("queues a body reference order that does not match the annexures", async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: "The petitioner relies on Annexure C, then Annexure A, then Annexure B." },
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.docx).toBeNull()
    expect(result.queue.map((entry) => entry.code)).toContain("order_unresolved")
  })

  it("queues a citation and a source that cannot be resolved", async () => {
    enableFlag()
    const cited = await generateDocket({
      ...petition,
      draft: { body: "The petitioner relies on Annexure A, Annexure B, Annexure C and Annexure D." },
    })
    expect(cited.ok).toBe(false)
    expect(cited.pdf).toBeNull()
    expect(cited.queue.some((entry) => entry.code === "ref_unresolved" && entry.detail.includes("D"))).toBe(true)

    const missingRef = await generateDocket({
      ...petition,
      annexures: petition.annexures.map((annexure, index) =>
        index === 2 ? { ...annexure, metadata: { ...annexure.metadata, sourceRef: null } } : annexure,
      ),
    })
    expect(missingRef.ok).toBe(false)
    expect(missingRef.docx).toBeNull()
    expect(missingRef.queue).toEqual([
      expect.objectContaining({ code: "ref_unresolved", artifactId: "ann-c", detail: "sourceRef is absent" }),
    ])
  })

  it("queues a second paper-book item when the rule only names Annexure A", async () => {
    enableFlag()
    const result = await generateDocket({
      ...impugned,
      annexures: [
        ...impugned.annexures,
        {
          metadata: {
            artifactId: "record-b",
            label: "Further record",
            required: true,
            status: "ready",
            sourceRef: "doc-record",
          },
          body: "Further record.",
        },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.code === "label_unresolved" && entry.artifactId === "record-b")).toBe(true)
  })

  it("accepts a plural list of the annexures that are in the filing set", async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: "The petitioner relies on Annexures A, B and C." },
    })
    expect(result.ok).toBe(true)
    expect(result.pdf).not.toBeNull()
    expect(result.docx).not.toBeNull()
    expect(result.queue).toEqual([])
  })

  it("queues citation variants that do not name an annexure in the set", async () => {
    enableFlag()
    const phrases: Array<{ phrase: string; canonicals: string[] }> = [
      { phrase: "ANNEXURE-D", canonicals: ["D"] },
      { phrase: "annexure d", canonicals: ["D"] },
      { phrase: "Annexures D and E", canonicals: ["D", "E"] },
      { phrase: "Annexure A1", canonicals: ["A1"] },
      { phrase: "ENCLOSURE 9", canonicals: ["9"] },
      { phrase: "Encl. 9", canonicals: ["9"] },
    ]
    for (const { phrase, canonicals } of phrases) {
      const result = await generateDocket({
        ...petition,
        draft: { body: `${petition.draft.body} ${phrase}.` },
      })
      expect(result.ok, phrase).toBe(false)
      expect(result.pdf, phrase).toBeNull()
      expect(result.docx, phrase).toBeNull()
      for (const canonical of canonicals) {
        expect(
          result.queue.some((entry) => entry.code === "ref_unresolved" && entry.detail.includes(canonical)),
          `${phrase} -> ${canonical}`,
        ).toBe(true)
      }
    }
  })

  it("queues mark variants, including a leading zero, that are not the assigned labels", async () => {
    enableFlag()
    const labeled = ambiguous.annexures.map((annexure, index) => ({
      ...annexure,
      assignedLabel: index === 0 ? "P/1" : "P/2",
    }))
    for (const phrase of ["p/99", "P-99", "P / 99", "P/01"]) {
      const canonical = phrase.toLowerCase() === "p/01" ? "P/01" : "P/99"
      const result = await generateDocket({
        ...ambiguous,
        draft: { body: `The plaintiff relies on ${phrase}.` },
        annexures: labeled,
      })
      expect(result.ok, phrase).toBe(false)
      expect(result.pdf, phrase).toBeNull()
      expect(result.docx, phrase).toBeNull()
      expect(
        result.queue.some((entry) => entry.code === "ref_unresolved" && entry.detail.includes(canonical)),
        phrase,
      ).toBe(true)
    }
  })

  it("rejects assigned labels that mix a letter series with a P mark", async () => {
    enableFlag()
    const result = await generateDocket({
      ...ambiguous,
      draft: { body: "The plaintiff relies on Annexure A and on P/1." },
      annexures: ambiguous.annexures.map((annexure, index) => ({
        ...annexure,
        assignedLabel: index === 0 ? "A" : "P/1",
      })),
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.docx).toBeNull()
    expect(result.queue.some((entry) => entry.code === "label_unresolved")).toBe(true)
  })

  it("refuses a docket while an annexure is pending or blocked", async () => {
    enableFlag()
    const blocked = await generateDocket(application)
    expect(blocked.ok).toBe(false)
    expect(blocked.pdf).toBeNull()
    expect(blocked.docx).toBeNull()
    expect(blocked.queue).toEqual([
      expect.objectContaining({
        code: "ref_unresolved",
        artifactId: "app-b",
        detail: "annexure status is blocked",
      }),
    ])

    const pending = await generateDocket({
      ...application,
      annexures: application.annexures.map((annexure) => ({
        ...annexure,
        metadata: { ...annexure.metadata, status: annexure.metadata.status === "blocked" ? "pending" : "ready" },
      })),
    })
    expect(pending.ok).toBe(false)
    expect(pending.pdf).toBeNull()
    expect(pending.docx).toBeNull()
    expect(pending.queue).toEqual([
      expect.objectContaining({
        code: "ref_unresolved",
        artifactId: "app-b",
        detail: "annexure status is pending",
      }),
    ])
  })

  it("queues an assigned label that breaks the stated series", async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      annexures: petition.annexures.map((annexure, index) =>
        index === 0 ? { ...annexure, assignedLabel: "C" } : annexure,
      ),
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.code === "label_unresolved" && entry.artifactId === "ann-a")).toBe(true)
  })

  it("reads label expressions and fails closed when one does not resolve", async () => {
    enableFlag()
    const letterPhrases: Array<{ phrase: string; canonical: string }> = [
      { phrase: "Annexure A\u2013E", canonical: "E" },
      { phrase: "Annexure A\u2014E", canonical: "E" },
      { phrase: 'Annexures "A" and "E"', canonical: "E" },
      { phrase: "Annexure \u201CD\u201D", canonical: "D" },
      { phrase: "Annexure (D)", canonical: "D" },
      { phrase: "Annex\u00ADure D", canonical: "D" },
      { phrase: "Annexure 4", canonical: "4" },
      { phrase: "Annexure-4", canonical: "4" },
      { phrase: "Annexure IV", canonical: "4" },
      { phrase: "Annexure No. 4", canonical: "4" },
      { phrase: "Annexure AA", canonical: "AA" },
      { phrase: "Annexures A, B, and E", canonical: "E" },
      { phrase: "Annexures A,E", canonical: "E" },
    ]
    for (const { phrase, canonical } of letterPhrases) {
      const result = await generateDocket({
        ...petition,
        draft: { body: `${petition.draft.body} ${phrase}.` },
      })
      expect(result.ok, phrase).toBe(false)
      expect(result.pdf, phrase).toBeNull()
      expect(result.docx, phrase).toBeNull()
      expect(
        result.queue.some((entry) => entry.code === "ref_unresolved" && entry.detail.includes(canonical)),
        phrase,
      ).toBe(true)
    }

  })

  it("reads enclosure expressions, including an annexure citation on an enclosure filing", async () => {
    enableFlag()
    const phrases = [
      "Enclosure No. 9",
      "Enclosure #9",
      "Enclosure \u20139",
      "Enclosure IX",
      "Enclosure (9)",
      "Enclosure 1 to 9",
      "Enclosure 1-9",
      "Enclosures 1, 2, and 9",
      "Encls. 9",
      "Annexure 9",
      "Annexure 1",
    ]
    for (const phrase of phrases) {
      const result = await generateDocket({
        ...enclosures,
        draft: { body: `${enclosures.draft.body} ${phrase}.` },
      })
      expect(result.ok, phrase).toBe(false)
      expect(result.pdf, phrase).toBeNull()
      expect(result.docx, phrase).toBeNull()
      expect(result.queue.some((entry) => entry.code === "ref_unresolved"), phrase).toBe(true)
    }
  })

  it("reads mark expressions and does not treat an address as an exhibit mark", async () => {
    enableFlag()
    const labeled = ambiguous.annexures.map((annexure, index) => ({
      ...annexure,
      assignedLabel: index === 0 ? "P/1" : "P/2",
    }))
    const markPhrases: Array<{ phrase: string; canonical: string }> = [
      { phrase: "P.99", canonical: "P/99" },
      { phrase: "P\u201399", canonical: "P/99" },
      { phrase: "P 99", canonical: "P/99" },
      { phrase: "P3", canonical: "P/3" },
      { phrase: "Ex.P3", canonical: "P/3" },
      { phrase: "P No. 3", canonical: "P/3" },
      { phrase: "P/1 to 5", canonical: "P/5" },
    ]
    for (const { phrase, canonical } of markPhrases) {
      const result = await generateDocket({
        ...ambiguous,
        draft: { body: `The plaintiff relies on P/1 and then P/2. ${phrase}.` },
        annexures: labeled,
      })
      expect(result.ok, phrase).toBe(false)
      expect(result.pdf, phrase).toBeNull()
      expect(result.docx, phrase).toBeNull()
      expect(
        result.queue.some((entry) => entry.code === "ref_unresolved" && entry.detail.includes(canonical)),
        phrase,
      ).toBe(true)
    }

    const addressed = await generateDocket({
      ...exhibits,
      draft: {
        body: "The witness proved P-1 and then P-2. House No. D-45, Clifton. R-123, Sector 11-A. Plot P-12. Form D-1.",
      },
    })
    expect(addressed.ok).toBe(true)
    expect(addressed.pdf).not.toBeNull()
    expect(addressed.docx).not.toBeNull()
    expect(addressed.queue).toEqual([])
  })

  it("generates when the letter expressions and the address lines are all present", async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: {
        body: [
          "The petitioner relies on Annexures A to C.",
          "Annexures A, B, and C.",
          "Annexure (C).",
          "Annexures A\u2013C.",
          "A-C.",
          "House No. D-45, Clifton.",
          "R-123, Sector 11-A.",
          "Plot P-12.",
          "Form D-1.",
        ].join(" "),
      },
    })
    expect(result.ok).toBe(true)
    expect(result.pdf).not.toBeNull()
    expect(result.docx).not.toBeNull()
    expect(result.queue).toEqual([])
  })

  it("refuses bare P, D, and R marks on every docket", async () => {
    enableFlag()
    const labeled = ambiguous.annexures.map((annexure, index) => ({
      ...annexure,
      assignedLabel: index === 0 ? "P/1" : "P/2",
    }))
    const foreign = [
      { phrase: "R/1", canonical: "R/1" },
      { phrase: "D/1", canonical: "D/1" },
    ]
    for (const { phrase, canonical } of foreign) {
      const result = await generateDocket({
        ...ambiguous,
        draft: { body: `The plaintiff relies on P/1 and then P/2. ${phrase}.` },
        annexures: labeled,
      })
      expect(result.ok, phrase).toBe(false)
      expect(result.pdf, phrase).toBeNull()
      expect(result.docx, phrase).toBeNull()
      expect(result.queue.some((entry) => entry.code === "ref_unresolved" && entry.detail.includes(canonical)), phrase).toBe(true)
    }

    const letter = await generateDocket({
      ...petition,
      draft: { body: `${petition.draft.body} P/3.` },
    })
    expect(letter.ok).toBe(false)
    expect(letter.pdf).toBeNull()
    expect(letter.queue.some((entry) => entry.detail.includes("P/3"))).toBe(true)

    const enclosure = await generateDocket({
      ...enclosures,
      draft: { body: `${enclosures.draft.body} P/9.` },
    })
    expect(enclosure.ok).toBe(false)
    expect(enclosure.pdf).toBeNull()
    expect(enclosure.queue.some((entry) => entry.detail.includes("P/9"))).toBe(true)
  })

  it("refuses a mark when an address word does not directly precede it", async () => {
    enableFlag()
    const labeled = ambiguous.annexures.map((annexure, index) => ({
      ...annexure,
      assignedLabel: index === 0 ? "P/1" : "P/2",
    }))
    for (const phrase of [
      "He lives on Main Street. P/3 is the deed.",
      "He lives in the same block. P/3 is the map.",
      "The plaintiff signed the form, P/3.",
    ]) {
      const result = await generateDocket({
        ...ambiguous,
        draft: { body: `The plaintiff relies on P/1 and then P/2. ${phrase}.` },
        annexures: labeled,
      })
      expect(result.ok, phrase).toBe(false)
      expect(result.pdf, phrase).toBeNull()
      expect(result.docx, phrase).toBeNull()
      expect(result.queue.some((entry) => entry.code === "ref_unresolved" && entry.detail.includes("P/3")), phrase).toBe(true)
    }
  })

  it("refuses a connector that names another label", async () => {
    enableFlag()
    const letterPhrases = ["C or D", "A/D", "A and/or D", "A, B and also D", "A as well as D", "A + D", "A; D"]
    for (const phrase of letterPhrases) {
      const result = await generateDocket({
        ...petition,
        draft: { body: `${petition.draft.body} Annexures ${phrase}.` },
      })
      expect(result.ok, phrase).toBe(false)
      expect(result.pdf, phrase).toBeNull()
      expect(result.docx, phrase).toBeNull()
      expect(result.queue.some((entry) => entry.code === "ref_unresolved" && entry.detail.includes("D")), phrase).toBe(true)
    }
    for (const phrase of ["Enclosure 2 or 9", "Enclosures 1/9"]) {
      const result = await generateDocket({
        ...enclosures,
        draft: { body: `${enclosures.draft.body} ${phrase}.` },
      })
      expect(result.ok, phrase).toBe(false)
      expect(result.pdf, phrase).toBeNull()
      expect(result.queue.some((entry) => entry.code === "ref_unresolved" && entry.detail.includes("9")), phrase).toBe(true)
    }
  })

  it("refuses abbreviated and glued citation keywords", async () => {
    enableFlag()
    const phrases = [
      { phrase: "Exh.P/3", canonical: "P/3" },
      { phrase: "Exh. D", canonical: "D" },
      { phrase: "Annexe D", canonical: "D" },
      { phrase: "Anx. D", canonical: "D" },
      { phrase: "Annx-D", canonical: "D" },
      { phrase: "Ann. D", canonical: "D" },
      { phrase: "Enc. 9", canonical: "9" },
      { phrase: "AnnexureD", canonical: "D" },
    ]
    for (const { phrase, canonical } of phrases) {
      const result = await generateDocket({
        ...petition,
        draft: { body: `${petition.draft.body} ${phrase}.` },
      })
      expect(result.ok, phrase).toBe(false)
      expect(result.pdf, phrase).toBeNull()
      expect(result.docx, phrase).toBeNull()
      expect(result.queue.some((entry) => entry.code === "ref_unresolved" && entry.detail.includes(canonical)), phrase).toBe(true)
    }
  })

  it("treats a soft hyphen as a separator before a label", async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: `${petition.draft.body} Annexure\u00ADD.` },
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.docx).toBeNull()
    expect(result.queue.some((entry) => entry.code === "ref_unresolved" && entry.detail.includes("D"))).toBe(true)
  })

  it("does not refuse a keyword unless a label follows it", async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: {
        body: [
          petition.draft.body,
          "The hearing is ex parte and also ex-parte and ex officio.",
          "Counsel will mark the margin. Mr. Mark appeared. The student got high marks.",
          "We annex herewith the affidavit, the annexure to this petition, as per annexure, and each annexure is signed.",
          "The enclosure of the letter and the exhibit was proved.",
        ].join(" "),
      },
    })
    expect(result.ok).toBe(true)
    expect(result.pdf).not.toBeNull()
    expect(result.docx).not.toBeNull()
    expect(result.queue).toEqual([])

    const pages = await generateDocket({
      ...ambiguous,
      draft: { body: "The plaintiff relies on P/1 and then P/2. See p. 3 of the judgment." },
      annexures: ambiguous.annexures.map((annexure, index) => ({
        ...annexure,
        assignedLabel: index === 0 ? "P/1" : "P/2",
      })),
    })
    expect(pages.ok).toBe(true)
    expect(pages.pdf).not.toBeNull()
    expect(pages.queue).toEqual([])

    const caseNumber = await generateDocket({
      ...ambiguous,
      draft: { body: "The defendant relies on D/1 and then D/2. C.P. No. D-1234/2025. D-12 Khayaban." },
      annexures: ambiguous.annexures.map((annexure, index) => ({
        ...annexure,
        assignedLabel: index === 0 ? "D/1" : "D/2",
      })),
    })
    expect(caseNumber.ok).toBe(true)
    expect(caseNumber.pdf).not.toBeNull()
    expect(caseNumber.queue).toEqual([])
  })

  it("refuses the sub-annexure label Annexure A-1", async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: `${petition.draft.body} Annexure A-1.` },
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.docx).toBeNull()
    expect(result.queue.some((entry) => entry.code === "ref_unresolved" && entry.detail.includes("A-1"))).toBe(true)
  })

  it("folds NFKC compatibility characters before reading a label", async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: `${petition.draft.body} Annexure \uFF24.` },
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.code === "ref_unresolved" && entry.detail.includes("D"))).toBe(true)
  })

  it("fails closed when a citation range exceeds the series", async () => {
    enableFlag()
    const result = await generateDocket({
      ...enclosures,
      draft: { body: `${enclosures.draft.body} Enclosure 1 to 100.` },
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.docx).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("without a label expression"))).toBe(true)
    expect(result.queue.some((entry) => entry.detail.includes("body cites 100"))).toBe(false)
  })

  it("reads a bare letter range as the annexures it spans", async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: "The petitioner relies on A-C." },
    })
    expect(result.ok).toBe(true)
    expect(result.pdf).not.toBeNull()
    expect(result.docx).not.toBeNull()
    expect(result.queue).toEqual([])
  })

  it('refuses "Relies on P/1, P/2 and P/99 which is the deed."', async () => {
    enableFlag()
    const result = await generateDocket({
      ...ambiguous,
      draft: { body: "Relies on P/1, P/2 and P/99 which is the deed." },
      annexures: ambiguous.annexures.map((annexure, index) => ({
        ...annexure,
        assignedLabel: index === 0 ? "P/1" : "P/2",
      })),
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.docx).toBeNull()
    expect(result.queue.some((entry) => entry.code === "ref_unresolved" && entry.detail.includes("P/99"))).toBe(true)
  })

  it('refuses "The receipt R/1 proves payment."', async () => {
    enableFlag()
    const result = await generateDocket({
      ...ambiguous,
      draft: { body: "The plaintiff relies on P/1 and then P/2. The receipt R/1 proves payment." },
      annexures: ambiguous.annexures.map((annexure, index) => ({
        ...annexure,
        assignedLabel: index === 0 ? "P/1" : "P/2",
      })),
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("R/1"))).toBe(true)
  })

  it('refuses "D/1 was produced by the defendant."', async () => {
    enableFlag()
    const result = await generateDocket({
      ...ambiguous,
      draft: { body: "The plaintiff relies on P/1 and then P/2. D/1 was produced by the defendant." },
      annexures: ambiguous.annexures.map((annexure, index) => ({
        ...annexure,
        assignedLabel: index === 0 ? "P/1" : "P/2",
      })),
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("D/1"))).toBe(true)
  })

  it('refuses "Agreement P/3 dated 01.01.2020 was executed at Karachi."', async () => {
    enableFlag()
    const result = await generateDocket({
      ...ambiguous,
      draft: { body: "The plaintiff relies on P/1 and then P/2. Agreement P/3 dated 01.01.2020 was executed at Karachi." },
      annexures: ambiguous.annexures.map((annexure, index) => ({
        ...annexure,
        assignedLabel: index === 0 ? "P/1" : "P/2",
      })),
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("P/3"))).toBe(true)
  })

  it('refuses "The deed (P/3) proves title."', async () => {
    enableFlag()
    const result = await generateDocket({
      ...ambiguous,
      draft: { body: "The plaintiff relies on P/1 and then P/2. The deed (P/3) proves title." },
      annexures: ambiguous.annexures.map((annexure, index) => ({
        ...annexure,
        assignedLabel: index === 0 ? "P/1" : "P/2",
      })),
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("P/3"))).toBe(true)
  })

  it('refuses "The order P/3 was passed." on a letter docket', async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: `${petition.draft.body} The order P/3 was passed.` },
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("P/3"))).toBe(true)
  })

  it('refuses "The order P/9 was passed." on an enclosure docket', async () => {
    enableFlag()
    const result = await generateDocket({
      ...enclosures,
      draft: { body: `${enclosures.draft.body} The order P/9 was passed.` },
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("P/9"))).toBe(true)
  })

  it('refuses "Annexure AB"', async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: `${petition.draft.body} The list includes Annexure AB.` },
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("without a label expression"))).toBe(true)
  })

  it('refuses "Annexure ABC"', async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: `${petition.draft.body} The list includes Annexure ABC.` },
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("without a label expression"))).toBe(true)
  })

  it('refuses "Annexure AB-1"', async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: `${petition.draft.body} The list includes Annexure AB-1.` },
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("without a label expression"))).toBe(true)
  })

  it('refuses "Annexure Four"', async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: `${petition.draft.body} The list includes Annexure Four.` },
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("without a label expression"))).toBe(true)
  })

  it('refuses "Enclosure nine"', async () => {
    enableFlag()
    const result = await generateDocket({
      ...enclosures,
      draft: { body: `${enclosures.draft.body} The letter also mentions Enclosure nine.` },
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("without a label expression"))).toBe(true)
  })

  it('refuses "the fourth annexure, D"', async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: `${petition.draft.body} The petitioner refers to the fourth annexure, D.` },
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("D"))).toBe(true)
  })

  it('refuses "Annex-" broken across a line', async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: `${petition.draft.body} The list stops at Annex-\n` },
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("without a label expression"))).toBe(true)
  })

  it('refuses "C but not D"', async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: `${petition.draft.body} The petitioner relies on Annexures C but not D.` },
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("without a label expression"))).toBe(true)
  })

  it('refuses "nor"', async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: `${petition.draft.body} The petitioner relies on Annexures C nor D.` },
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("without a label expression"))).toBe(true)
  })

  it('refuses "followed by"', async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: `${petition.draft.body} The petitioner relies on Annexure C followed by D.` },
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("without a label expression"))).toBe(true)
  })

  it('refuses "then" between labels', async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: `${petition.draft.body} The petitioner relies on Annexures C then D.` },
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("without a label expression"))).toBe(true)
  })

  it('refuses "plus"', async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: `${petition.draft.body} The petitioner relies on Annexures C plus D.` },
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("without a label expression"))).toBe(true)
  })

  it('refuses "with"', async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: `${petition.draft.body} The petitioner relies on Annexures C with D.` },
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("without a label expression"))).toBe(true)
  })

  it('refuses "A…D"', async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: `${petition.draft.body} The petitioner relies on Annexures A\u2026D.` },
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("without a label expression"))).toBe(true)
  })

  it('refuses "A...D"', async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: `${petition.draft.body} The petitioner relies on Annexures A...D.` },
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("without a label expression"))).toBe(true)
  })

  it('refuses "et seq."', async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: `${petition.draft.body} The petitioner relies on Annexure A et seq.` },
    })
    expect(result.ok).toBe(false)
    expect(result.pdf).toBeNull()
    expect(result.queue.some((entry) => entry.detail.includes("without a label expression"))).toBe(true)
  })

  it('generates "Annexure A, Annexure B or Annexure C" when every annexure exists', async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: "Annexure A, Annexure B or Annexure C." },
    })
    expect(result.ok).toBe(true)
    expect(result.pdf).not.toBeNull()
    expect(result.docx).not.toBeNull()
    expect(result.queue).toEqual([])
  })

  it('generates "D-45/2, Block 5"', async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: `${petition.draft.body} The house is D-45/2, Block 5.` },
    })
    expect(result.ok).toBe(true)
    expect(result.pdf).not.toBeNull()
    expect(result.queue).toEqual([])
  })

  it('generates glued "p.3, para 4"', async () => {
    enableFlag()
    const result = await generateDocket({
      ...ambiguous,
      draft: { body: "The plaintiff relies on P/1 and then P/2. See p.3, para 4 of the judgment." },
      annexures: ambiguous.annexures.map((annexure, index) => ({
        ...annexure,
        assignedLabel: index === 0 ? "P/1" : "P/2",
      })),
    })
    expect(result.ok).toBe(true)
    expect(result.pdf).not.toBeNull()
    expect(result.queue).toEqual([])
  })

  it('generates a spaced "p. 3" page reference and fails if that rule is removed', async () => {
    enableFlag()
    const result = await generateDocket({
      ...ambiguous,
      draft: { body: "The plaintiff relies on P/1 and then P/2. See p. 3 of the judgment. See pp. 4 of the judgment." },
      annexures: ambiguous.annexures.map((annexure, index) => ({
        ...annexure,
        assignedLabel: index === 0 ? "P/1" : "P/2",
      })),
    })
    expect(result.ok).toBe(true)
    expect(result.pdf).not.toBeNull()
    expect(result.queue).toEqual([])
  })

  it("cites assigned Annexures A-1, A-2 and A-3 through the same grammar", async () => {
    enableFlag()
    const base = ambiguous.annexures[0]
    if (!base) throw new Error("ambiguous fixture has no annexure")
    const result = await generateDocket({
      ...ambiguous,
      draft: { body: "The plaintiff relies on Annexures A-1, A-2 and A-3." },
      annexures: [1, 2, 3].map((n) => ({
        ...base,
        assignedLabel: `A-${n}`,
        metadata: { ...base.metadata, artifactId: `sub-${n}`, label: `Sub ${n}`, sourceRef: `sub-${n}` },
        body: `Sub annexure ${n}.`,
      })),
    })
    expect(result.ok).toBe(true)
    expect(result.pdf).not.toBeNull()
    expect(result.docx).not.toBeNull()
    expect(result.queue).toEqual([])

    const doubled = await generateDocket({
      ...ambiguous,
      draft: { body: "The plaintiff relies on Annexure AA." },
      annexures: [
        {
          ...base,
          assignedLabel: "AA",
          metadata: { ...base.metadata, artifactId: "sub-aa", label: "Doubled", sourceRef: "sub-aa" },
          body: "Doubled annexure.",
        },
      ],
    })
    expect(doubled.ok).toBe(true)
    expect(doubled.pdf).not.toBeNull()
    expect(doubled.queue).toEqual([])
  })
})

function docxSections(bytes: Uint8Array): Array<{ width: number; height: number; margins: Record<string, number>; pageFields: number; text: string; exactLines: number[] }> {
  const document = strFromU8(unzipSync(bytes)["word/document.xml"] ?? new Uint8Array())
  const markers = [...document.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)]
  let cursor = 0
  return markers.map((marker) => {
    const sect = marker[0]
    const sectEnd = (marker.index ?? 0) + sect.length
    const paragraphEnd = document.indexOf("</w:p>", sectEnd)
    const bodyEnd = paragraphEnd === -1 ? sectEnd : paragraphEnd + "</w:p>".length
    const body = document.slice(cursor, bodyEnd)
    cursor = bodyEnd
    const size = sect.match(/<w:pgSz[^>]*w:w="(\d+)"[^>]*w:h="(\d+)"/)
    const margin = sect.match(/<w:pgMar\b[^>]*\/>/)?.[0] ?? sect.match(/<w:pgMar\b[^>]*>/)?.[0] ?? ""
    const margins: Record<string, number> = {}
    for (const name of ["top", "right", "bottom", "left"]) {
      const found = margin.match(new RegExp(`w:${name}="(\\d+)"`))
      margins[name] = found ? Number(found[1]) : 0
    }
    const text = [...body.matchAll(/<w:t(?:[^>]*)>([^<]*)<\/w:t>/g)].map((match) => match[1] ?? "").join("")
    const pageFields = [...body.matchAll(/<w:instrText[^>]*>[^<]*\bPAGE\b/g)].length
    const exactLines = [...body.matchAll(/<w:spacing\b[^>]*w:line="(\d+)"[^>]*w:lineRule="exact"/g)].map((match) => Number(match[1]))
    return {
      width: size ? Number(size[1]) : 0,
      height: size ? Number(size[2]) : 0,
      margins,
      pageFields,
      text,
      exactLines,
    }
  })
}

describe("L5.5 docx pagination", () => {
  it("gives each plan page its own section, exact spacing, and a PAGE field on content leaves", async () => {
    enableFlag()
    const filing: DocketFilingSet = {
      ...petition,
      annexures: petition.annexures.map((annexure, index) =>
        index === 1
          ? {
              ...annexure,
              body: Array.from({ length: 400 }, () => "The record continues on this leaf of the paper-book.").join("\n"),
            }
          : annexure,
      ),
    }
    const result = await generateDocket(filing)
    expect(result.ok).toBe(true)
    const pdf = await pdfPages(result.pdf!)
    const sections = docxSections(result.docx!)
    expect(sections).toHaveLength(pdf.texts.length)
    expect(sections.length).toBeGreaterThan(10)
    for (const [index, section] of sections.entries()) {
      expect(section.width).toBe(12240)
      expect(section.height).toBe(20160)
      expect(section.margins).toEqual({ top: 2160, right: 1440, bottom: 2160, left: 1440 })
      expect(section.exactLines.length).toBeGreaterThan(0)
      if (index % 2 === 1) {
        expect(section.text.replace(/\s/g, "")).toBe("")
        expect(section.pageFields).toBe(0)
      } else {
        expect(section.pageFields).toBe(1)
      }
    }
    const document = strFromU8(unzipSync(result.docx!)["word/document.xml"] ?? new Uint8Array())
    expect(document).toContain('w:ascii="Times New Roman"')
    expect(document).toContain('w:lineRule="exact"')
    expect(document).toContain('w:val="nextPage"')
  })

  it("keeps the same docx bytes in UTC and in New York", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
    const probe = path.join(root, "tests/l5-5-docx-tz-probe.ts")
    const bin = path.join(root, "node_modules/.bin/tsx")
    const render = (tz: string) => {
      const out = path.join("/tmp", `q12a-docket-${tz.replace(/\//g, "_")}.docx`)
      const run = spawnSync(bin, [probe], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, TZ: tz, DOCKET_TZ_OUT: out },
      })
      expect(run.status, `${tz}\n${run.stdout}\n${run.stderr}`).toBe(0)
      return readFileSync(out)
    }
    expect(Buffer.compare(render("UTC"), render("America/New_York"))).toBe(0)
  }, 60000)
})

const PROSE = [
  "petitioner", "respectfully", "submits", "constitutional", "jurisdiction", "impugned", "order",
  "notice", "served", "respondent", "affidavit", "paragraph", "record", "produced", "counsel",
  "heard", "learned", "court", "holds", "accordingly", "prayed", "granted", "dismissed", "appeal",
  "statute", "provision", "section", "article", "rights", "liberty", "property", "procedure",
  "natural", "justice", "reasons", "brief", "grounds", "stated", "above", "below", "witness",
  "document", "copy", "certified", "date", "place", "karachi", "lahore", "islamabad", "quotation",
  "mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm",
]

function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function prosePetition(seed: number): DocketFilingSet {
  const random = mulberry32(seed)
  const count = 220 + Math.floor(random() * 180)
  const words: string[] = []
  for (let index = 0; index < count; index++) words.push(PROSE[Math.floor(random() * PROSE.length)] ?? "petition")
  return {
    ...petition,
    draft: {
      body: `The petitioner relies on Annexure A and thereafter on Annexure B and Annexure C. ${words.join(" ")}`,
    },
  }
}

function assertLinesFit(lines: readonly { text: string; size: number; bold: boolean }[], measure: number): void {
  for (const line of lines) {
    const width = tnrWidth(line.text, line.size, line.bold)
    expect(width).toBeLessThanOrEqual(measure + 1e-6)
    if (line.text.includes(" ")) expect(width).toBeLessThanOrEqual(measure * WRAP_SLACK + 0.05)
  }
}

describe("L5.5 Times New Roman line measure", () => {
  it("keeps every wrapped line inside the measure under Tinos widths", () => {
    const measure = contentBox(pagePoints("legal")).width
    const sample = `${"The petitioner respectfully submits that the constitutional jurisdiction of this Court is invoked. ".repeat(12)}mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm`
    for (const line of wrapParagraph(sample, 12, measure, false)) {
      expect(tnrWidth(line, 12, false)).toBeLessThanOrEqual(measure + 1e-6)
    }
    const resolved = resolveFilingSet(petition)
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const plan = planDocket(resolved.docket)
    expect("pages" in plan).toBe(true)
    if (!("pages" in plan)) return
    assertLinesFit(plan.pages.flatMap((page) => page.lines), contentBox(plan.pageSize).width)
  })

  it("keeps packed lines inside 97 percent of the Tinos measure", () => {
    const measure = contentBox(pagePoints("legal")).width
    const packed = Array.from({ length: 400 }, () => "the").join(" ")
    const widthOf = (line: string) => {
      let units = 0
      for (const character of line) {
        const code = character.codePointAt(0) ?? 0
        units += code >= 32 && code <= 126 ? (TINOS_REGULAR_WIDTHS[code - 32] ?? TINOS_UNITS_PER_EM) : TINOS_UNITS_PER_EM
      }
      return (units / TINOS_UNITS_PER_EM) * 12
    }
    expect(TINOS_REGULAR_WIDTHS[0]).toBe(512)
    expect(TINOS_REGULAR_WIDTHS["t".charCodeAt(0) - 32]).toBe(569)
    const lines = wrapParagraph(packed, 12, measure, false).filter((line) => line.includes(" "))
    expect(lines.length).toBeGreaterThan(5)
    let widest = 0
    for (const line of lines) {
      const width = widthOf(line)
      widest = Math.max(widest, width)
      expect(width).toBeLessThanOrEqual(measure + 1e-6)
      expect(width).toBeLessThanOrEqual(measure * 0.97 + 0.05)
    }
    expect(widest).toBeGreaterThan(measure * 0.9)
  })

  it("fits each line of twelve seeded prose petitions under Tinos widths", async () => {
    enableFlag()
    const seeds = Array.from({ length: 12 }, (_, index) => 12000 + index)
    for (const seed of seeds) {
      const filing = prosePetition(seed)
      const result = await generateDocket(filing)
      expect(result.ok, `seed ${seed}`).toBe(true)
      const resolved = resolveFilingSet(filing)
      expect(resolved.ok).toBe(true)
      if (!resolved.ok) continue
      const plan = planDocket(resolved.docket)
      expect("pages" in plan).toBe(true)
      if (!("pages" in plan)) continue
      const measure = contentBox(plan.pageSize).width
      assertLinesFit(plan.pages.flatMap((page) => page.lines), measure)
      const document = strFromU8(unzipSync(result.docx!)["word/document.xml"] ?? new Uint8Array())
      expect(document, `seed ${seed}`).not.toContain("<w:br")
      expect(document, `seed ${seed}`).not.toContain('w:wordWrap w:val="false"')
      expect(document, `seed ${seed}`).not.toContain('w:wordWrap w:val="0"')
      const lineCount = plan.pages.reduce((sum, page) => sum + page.lines.length, 0)
      const paragraphCount = [...document.matchAll(/<w:p[ >]/g)].length
      expect(paragraphCount, `seed ${seed}`).toBeGreaterThan(0)
      expect(paragraphCount, `seed ${seed}`).toBeLessThan(lineCount)
      expect(plan.pages).toHaveLength(docxSections(result.docx!).length)
    }
  })
})

describe("L5.5 fail-closed reference allowlist", () => {
  const addressWords = ["block", "sector", "phase", "gali", "mohalla", "lane", "road", "street", "house"]

  function marked(labels: string[]): DocketFilingSet {
    return {
      ...ambiguous,
      annexures: ambiguous.annexures.map((annexure, index) => ({
        ...annexure,
        assignedLabel: labels[index] ?? labels[0],
      })),
    }
  }

  async function expectRefusal(filing: DocketFilingSet, sentence: string): Promise<void> {
    enableFlag()
    const result = await generateDocket(filing)
    expect(result.ok, sentence).toBe(false)
    expect(result.pdf, sentence).toBeNull()
    expect(result.docx, sentence).toBeNull()
    expect(result.queue.some((entry) => entry.code === "ref_unresolved"), sentence).toBe(true)
  }

  async function expectGeneration(filing: DocketFilingSet, sentence: string): Promise<void> {
    enableFlag()
    const result = await generateDocket(filing)
    expect(result.ok, sentence).toBe(true)
    expect(result.pdf, sentence).not.toBeNull()
    expect(result.docx, sentence).not.toBeNull()
    expect(result.queue, sentence).toEqual([])
  }

  it("REF-015 refuses a slash mark beside an address word", async () => {
    const sentences = [
      "Relies on P/1 and P/2. Relies on P/3, Block 5 of the deed.",
      "Relies on P/1 and P/2. P/3, Street plan.",
      "Relies on P/1 and P/2. P/99, House.",
      "Relies on P/1 and P/2. The plan P/9, Sector shows the boundary.",
      "Relies on P/1 and P/2. See P/3, house deed.",
      "Relies on P/1 and P/2. Relies on P/3/2, Block.",
      "Relies on P/1 and P/2. Relies on P/3, BLOCK plan.",
      "Relies on P/1 and P/2. Relies on P/3 Khayaban-e-Ittehad lease.",
      "Relies on P/1 and P/2. The sale deed of the house P/3 is relied on.",
    ]
    for (const sentence of sentences) {
      await expectRefusal({ ...marked(["P/1", "P/2"]), draft: { body: sentence } }, sentence)
    }
    await expectRefusal(
      { ...marked(["D/1", "D/2"]), draft: { body: "Relies on D/1 and D/2. D/9 Street." } },
      "Relies on D/1 and D/2. D/9 Street.",
    )
  })

  it("REF-015 refuses every address word after a slash mark and before a slash mark", async () => {
    const words = addressWords.map((word) => word[0]!.toUpperCase() + word.slice(1))
    const filings: Array<{ name: string; filing: DocketFilingSet; cited: string; mark: string }> = [
      { name: "P", filing: marked(["P/1", "P/2"]), cited: "Relies on P/1 and P/2.", mark: "P/3" },
      { name: "D", filing: marked(["D/1", "D/2"]), cited: "Relies on D/1 and D/2.", mark: "D/3" },
      { name: "R", filing: marked(["R/1", "R/2"]), cited: "Relies on R/1 and R/2.", mark: "R/3" },
      {
        name: "letter",
        filing: petition,
        cited: "The petitioner relies on Annexures A, B and C.",
        mark: "P/3",
      },
      {
        name: "enclosure",
        filing: enclosures,
        cited: "1. The letter encloses Enclosure 1 and then Enclosure 2.",
        mark: "P/3",
      },
    ]
    expect(words.length * filings.length + words.length).toBe(54)
    for (const word of words) {
      for (const row of filings) {
        const sentence = `${row.cited} Relies on ${row.mark}, ${word} 5.`
        await expectRefusal({ ...row.filing, draft: { body: sentence } }, `${row.name} ${sentence}`)
        const bare = `${row.cited} ${row.mark}, ${word} 5.`
        await expectRefusal({ ...row.filing, draft: { body: bare } }, `bare ${row.name} ${bare}`)
      }
      const before = `Relies on P/1 and P/2. ${word} P/3.`
      await expectRefusal({ ...marked(["P/1", "P/2"]), draft: { body: before } }, before)
      const bareBefore = `P/1 and P/2. ${word} P/3.`
      await expectRefusal({ ...marked(["P/1", "P/2"]), draft: { body: bareBefore } }, bareBefore)
    }
  })

  it("REF-015 generates dash-code addresses, an or-list, and a glued page reference", async () => {
    const dash = [
      "At P-12, Phase VIII, DHA.",
      "At R-12, Gali No. 4, Mohalla Islampura.",
      "D-12 Khayaban-e-Shamsheer",
      "House No. D-45, Clifton",
      "D-45/2, Block 5",
    ]
    for (const sentence of dash) {
      await expectGeneration(
        { ...marked(["P/1", "P/2"]), draft: { body: `Relies on P/1 and P/2. ${sentence}` } },
        sentence,
      )
    }
    await expectGeneration(
      { ...petition, draft: { body: "Annexure A, Annexure B or Annexure C" } },
      "Annexure A, Annexure B or Annexure C",
    )
    await expectGeneration(
      { ...marked(["P/1", "P/2"]), draft: { body: "Relies on P/1 and P/2. p.3, para 4" } },
      "p.3, para 4",
    )
  })

  it("REF-012 refuses a label after a non-connector", async () => {
    const prefix = "The petitioner relies on Annexures A, B and C."
    const sentences = [
      "See Annexures C, followed by D.",
      "See Annexures C, then D.",
      "See Annexures C, as well as D.",
      "See Annexure C along with D.",
      "See Annexure C together with D.",
      "See Annexure C besides D.",
      "See Annexures A through D.",
      "See Annexures A till D.",
      "See Annexures A up to D.",
      "See Annexures C & then D.",
      "See Annexures C and then D.",
      "See the annexure namely D.",
      "The copy is annexure marked as D.",
      "See annexure to the petition D.",
      "See the ninth Annexure.",
    ]
    for (const sentence of sentences) {
      await expectRefusal({ ...petition, draft: { body: `${prefix} ${sentence}` } }, sentence)
    }
    await expectRefusal(
      { ...enclosures, draft: { body: "See Enclosure hundred." } },
      "See Enclosure hundred.",
    )
  })

  it("REF-016 refuses when the article a is not Annexure A", async () => {
    const sentences = [
      "The annexure is a true copy. The petitioner relies on Annexures B and C.",
      "The annexure of a sale is attached. The petitioner relies on Annexures B and C.",
    ]
    for (const sentence of sentences) {
      await expectRefusal({ ...petition, draft: { body: sentence } }, sentence)
    }
  })

  it("OVER-014 generates prose that is not a citation", async () => {
    const letter = [
      "He obtained high marks in the examination.",
      "The annexures are true copies.",
      "All annexures are certified.",
      "The annexures by the respondent are forged.",
      "The annexures on record are true.",
      "No annexure or document is withheld.",
      "The marks or signatures are genuine.",
      "Please mark as urgent.",
      "The mark up on the loan was 12%.",
      "See p.3 of the order.",
    ]
    const cited = "The petitioner relies on Annexures A, B and C."
    for (const sentence of letter) {
      await expectGeneration({ ...petition, draft: { body: `${cited} ${sentence}` } }, sentence)
    }
    const enclosed = "1. The letter encloses Enclosure 1 and then Enclosure 2."
    for (const sentence of ["The enclosures are true copies.", "2. The enclosure is a copy."]) {
      await expectGeneration({ ...enclosures, draft: { body: `${enclosed} ${sentence}` } }, sentence)
    }
  })

  it("MAN-017 does not treat a lookalike as exhibit P-1 or P-2", async () => {
    const sentences = [
      "The witness proved P-1/2 and then P-2/3.",
      "The witness proved P-1.5 and then P-2.5.",
      "See www.example.com/P-1 and file_P-2.",
      "The witness proved P-10 and then P-2.",
      "The witness proved CP-1 and then P-2.",
      "The witness proved P-1-A and then P-2.",
    ]
    for (const sentence of sentences) {
      enableFlag()
      const result = await generateDocket({ ...exhibits, draft: { body: sentence } })
      expect(result.ok, sentence).toBe(false)
      expect(result.pdf, sentence).toBeNull()
      expect(result.queue.some((entry) => entry.detail === "body does not refer to P-1"), sentence).toBe(true)
    }
  })

  it("generates the sub-annexure range Annexures A-1 to A-3", async () => {
    const base = ambiguous.annexures[0]
    if (!base) throw new Error("ambiguous fixture has no annexure")
    await expectGeneration(
      {
        ...ambiguous,
        draft: { body: "The plaintiff relies on Annexures A-1 to A-3." },
        annexures: [1, 2, 3].map((n) => ({
          ...base,
          assignedLabel: `A-${n}`,
          metadata: { ...base.metadata, artifactId: `range-${n}`, label: `Range ${n}`, sourceRef: `range-${n}` },
          body: `Range annexure ${n}.`,
        })),
      },
      "Annexures A-1 to A-3",
    )
  })

  it("classifies Annexure A-1 through the expression fallback", () => {
    expect(assignedCitation("Annexure A-1")).toEqual({ form: "annex:A-1", series: "letter" })
  })

  it("refuses Annexure ABCD-1", async () => {
    await expectRefusal(
      { ...petition, draft: { body: `${petition.draft.body} Annexure ABCD-1.` } },
      "Annexure ABCD-1",
    )
  })

  it("generates when an incomplete bare range A-D follows a complete citation", async () => {
    await expectGeneration(
      { ...petition, draft: { body: "The petitioner relies on Annexures A, B and C. A-D." } },
      "A-D",
    )
  })

  it("reads P-1 after did not prove", async () => {
    await expectGeneration({ ...exhibits, draft: { body: "The witness did not prove P-1 or P-2." } }, "did not prove")
  })

  it("REF-018 refuses a bare mark that a skip used to hide", async () => {
    const cited = "Relies on P/1 and P/2."
    const sentences = [
      "The defendant has not denied P/3.",
      "It is not disputed that P-9 is the sale deed.",
      "did not deny P/9 at all, and P/9 is the sale deed",
      "LIST OF EXHIBITS\nP/9 Sale deed\nThe plaintiff relies on P/1 and P/2 and P/9",
      "sale-deed/P-9",
      "deed/P/9",
      "and/P/9",
      "P_9",
      "Copy No. P-9",
      "sale deed No. P-9",
    ]
    for (const sentence of sentences) {
      await expectRefusal({ ...marked(["P/1", "P/2"]), draft: { body: `${cited} ${sentence}` } }, sentence)
    }
    await expectRefusal(
      { ...petition, draft: { body: `${petition.draft.body} Annexure_D` } },
      "Annexure_D",
    )
  })

  it("REF-019 refuses a label split by a line-break hyphen", async () => {
    for (const sentence of ["See Annex-\nure D.", "Annex-\nure D is attached."]) {
      enableFlag()
      const result = await generateDocket({ ...petition, draft: { body: `${petition.draft.body} ${sentence}` } })
      expect(result.ok, sentence).toBe(false)
      expect(result.queue.some((entry) => entry.detail.includes("cites D")), sentence).toBe(true)
    }
  })

  it("OVER-020 generates legal prose that is not an annexure citation", async () => {
    const cited = "The petitioner relies on Annexures A, B and C."
    const sentences = [
      "The petitioner relies on 2021 SCMR 1234.",
      "See 2021 SCMR 1234.",
      "The petitioner relies on Order XXI Rule 2 CPC.",
      "See also Section 9 CPC.",
      "See Section 12(2) CPC.",
      "The petitioner relies on the FIR.",
      "The petitioner relies on para A of the judgment.",
      "The petitioner relies on the following grounds: (a) delay; (b) fraud.",
      "Annexures A, B and C were issued under Section 7 of the Act.",
      "Annexure A was signed by me.",
      "Annexure A shows payment of Rs. 5,000.",
      "Annexure A is the order of the AC.",
      "See p. 3.",
      "See p.3.",
      "See p. 3, line 4.",
      "See pp. 3-5 of the record.",
      "See Annexure A at p. 3.",
    ]
    for (const sentence of sentences) {
      const body = sentence.startsWith("Annexures A, B and C") ? sentence : `${cited} ${sentence}`
      await expectGeneration({ ...petition, draft: { body } }, sentence)
    }
  })

  it("OVER-021 generates a case number with of and a year", async () => {
    const cited = "The petitioner relies on Annexures A, B and C."
    for (const sentence of [
      "C.P. No. D-1234 of 2023",
      "CP No. D-1234 of 2023",
      "Execution No. D-45 of 2024",
      "Crl. Rev. No. D-45 of 2024",
      "Crl. A. No. D-45 of 2024",
      "H.C.A. No. D-45 of 2024",
      "Const. P. No. D-45 of 2024",
      "R.F.A. No. D-45 of 2024",
      "Execution No. D-45/2024",
    ]) {
      await expectGeneration({ ...petition, draft: { body: `${cited} ${sentence}` } }, sentence)
    }
  })

  it("REF-023 reads a label or mark split by one newline", async () => {
    const cited = "The petitioner relies on Annexures A, B and C."
    const letters = [
      "See Annexures A, B and\nD.",
      "See Annexures A, B,\nC and D.",
      "A,\nD",
      "A to\nD",
      "See Annexure\n\nD.",
      "See Annexure\r\n\r\nD.",
      "ANNEXURES:\nD - Bank statement",
      "ANNEXURE:\nD",
    ]
    for (const sentence of letters) {
      enableFlag()
      const result = await generateDocket({ ...petition, draft: { body: `${cited} ${sentence}` } })
      expect(result.ok, sentence).toBe(false)
      expect(result.queue.some((entry) => entry.detail.includes("D")), sentence).toBe(true)
    }
    const marks = ["The deed P-\n9 is relied on.", "P/\n9", "P\n/9", "P-\r\n9"]
    for (const sentence of marks) {
      enableFlag()
      const result = await generateDocket({ ...marked(["P-1", "P-2"]), draft: { body: `Relies on P/1 and P/2. ${sentence}` } })
      expect(result.ok, sentence).toBe(false)
      expect(result.queue.some((entry) => entry.detail.includes("P/9")), sentence).toBe(true)
    }
  })

  it("REF-024 refuses an unreadable short label without a sentence end", async () => {
    const cited = "The petitioner relies on Annexures A, B and C."
    const sentences = [
      "See Annexures AB and AC.",
      "See Annexures viz. D.",
      "viz. D and E",
      "Annexure AB is the deed.",
      "See Annexure AB, the deed.",
      "See Annexure ab.",
    ]
    for (const sentence of sentences) {
      enableFlag()
      const result = await generateDocket({ ...petition, draft: { body: `${cited} ${sentence}` } })
      expect(result.ok, sentence).toBe(false)
      if (sentence.includes("viz")) expect(result.queue.some((entry) => entry.detail.includes("D")), sentence).toBe(true)
    }
  })

  it("REF-018-R counts a heading mark and leaves the heading out of the order", async () => {
    for (const sentence of ["LIST OF EXHIBITS: P-1, P-2, P-9.", "List of exhibits P/9 relied upon."]) {
      enableFlag()
      const result = await generateDocket({ ...marked(["P-1", "P-2"]), draft: { body: sentence } })
      expect(result.ok, sentence).toBe(false)
      expect(result.queue.some((entry) => entry.detail.includes("P/9")), sentence).toBe(true)
    }
    enableFlag()
    const unfiled = await generateDocket({
      ...exhibits,
      draft: { body: "LIST OF EXHIBITS: P-1, P-2, P-3.\nThe witness proved P-1 and then P-2." },
    })
    expect(unfiled.ok).toBe(false)
    expect(unfiled.queue.some((entry) => entry.detail.includes("P/3"))).toBe(true)
    expect(unfiled.queue.some((entry) => entry.detail.includes("different order"))).toBe(false)
    await expectGeneration({ ...exhibits, draft: { body: "LIST OF EXHIBITS: P-1, P-2." } }, "assigned heading")
    await expectGeneration(
      { ...exhibits, draft: { body: "LIST OF EXHIBITS: P-2, P-1. The witness proved P-1 and then P-2." } },
      "heading order ignored",
    )
  })

  it("refuses an exhibit body that cites the assigned marks out of order", async () => {
    enableFlag()
    const result = await generateDocket({ ...exhibits, draft: { body: "The witness proved P-2 and then P-1." } })
    expect(result.ok).toBe(false)
    expect(result.queue.some((entry) => entry.code === "order_unresolved")).toBe(true)
  })

  it("OVER-020-R keeps an agency, a report citation, and a bare year", async () => {
    const cited = "The petitioner relies on Annexures A, B and C."
    const sentences = [
      "Annexure A was issued by NAB.",
      "Annexure A was issued by the SHC.",
      "Annexure A was issued from KDA.",
      "Annexure A was issued from the ECP.",
      "Annexure A was issued by IT.",
      "Annexure A was issued by the FBR.",
      "Annexure A was issued by the CDA.",
      "Annexure A was issued by LDA.",
      "Annexure A was issued with the SHO.",
      "Annexure A was issued by the DSP.",
      "See PW-1's deposition.",
      "See ECP.",
      "See I. Ahmed v. State.",
      "See 2010 NLR 45.",
      "See 2010 KLR 45",
      "See 2015 PLJ 45",
      "See 2015 PLC (C.S.) 45",
      "See (2010) 5 SCC 45",
      "See 2010.",
    ]
    for (const sentence of sentences) {
      await expectGeneration({ ...petition, draft: { body: `${cited} ${sentence}` } }, sentence)
    }
  })

  it("ORDER-R8-001 refuses an annexure sentence that is out of filing order", async () => {
    const sentences = [
      "Annexure C is the receipt. Annexure B is the deed. Annexure A is the plaint.",
      "Annexures C, B and A are relied on.",
      "Annexure C, Annexure B and Annexure A are filed.",
      "Annexures B, A and C are relied on.",
      "Annexure B is the deed. Annexure A is the plaint. Annexure C is the receipt.",
      "Annexures C and B and A are relied on.",
    ]
    for (const sentence of sentences) {
      enableFlag()
      const result = await generateDocket({ ...petition, draft: { body: sentence } })
      expect(result.ok, sentence).toBe(false)
      expect(result.queue.some((entry) => entry.code === "order_unresolved"), sentence).toBe(true)
    }
    await expectGeneration(
      {
        ...petition,
        draft: { body: "Annexure A is the plaint. Annexure B is the deed. Annexure C is the receipt." },
      },
      "in-order annexure sentences",
    )
    await expectGeneration(
      { ...petition, draft: { body: "Annexures A, B and C are relied on." } },
      "in-order annexure list",
    )
    enableFlag()
    const partial = await generateDocket({
      ...petition,
      draft: { body: "LIST OF ANNEXURES: Annexure A. Annexure C is the receipt. Annexure B is the deed." },
    })
    expect(partial.ok).toBe(false)
    expect(partial.queue.some((entry) => entry.code === "order_unresolved")).toBe(true)
    expect(partial.queue.some((entry) => entry.detail === "body does not refer to A")).toBe(false)
    const third = exhibits.annexures[1]!
    enableFlag()
    const manual = await generateDocket({
      ...exhibits,
      annexures: [
        ...exhibits.annexures,
        {
          ...third,
          assignedLabel: "P-3",
          metadata: { ...third.metadata, artifactId: "ex-3", label: "Map", sourceRef: "doc-map" },
        },
      ],
      draft: { body: "LIST OF EXHIBITS: P-1. The witness proved P-3 and then P-2." },
    })
    expect(manual.ok).toBe(false)
    expect(manual.queue.some((entry) => entry.code === "order_unresolved")).toBe(true)
  })

  it("OVER-020-R generates a fresh acronym and an AIR report after see or refer", async () => {
    const cited = "The petitioner relies on Annexures A, B and C."
    for (const sentence of [
      "See FIA report.",
      "See PTA.",
      "Refer SBP circular.",
      "See SSP report.",
      "See AIR 1950 SC 27.",
      "See NAB report.",
      "See SECP circular.",
    ]) {
      await expectGeneration({ ...petition, draft: { body: `${cited} ${sentence}` } }, sentence)
    }
  })

  it("OVER-R8-002 generates prose letters and a head followed by a stopword", async () => {
    const cited = "The petitioner relies on Annexures A, B and C."
    for (const sentence of [
      "Schedules D and E of the Act apply.",
      "The parties X and Y agreed.",
      "I and a colleague attended.",
      "Under clauses (d) and (e) of the agreement.",
      "See exhibits on record.",
      "Refer annexures filed herewith.",
    ]) {
      await expectGeneration({ ...petition, draft: { body: `${cited} ${sentence}` } }, sentence)
    }
  })

  it("TEST-R8 refuses an unreadable label and a mark before Street map", async () => {
    const cited = "The petitioner relies on Annexures A, B and C."
    for (const sentence of ["See Annexure Art. D.", "See Annexure IT.", "Annexure ab is the deed.", "Annexure Ab is the deed.", "Annexure ab/Ab is the deed."]) {
      enableFlag()
      const result = await generateDocket({ ...petition, draft: { body: `${cited} ${sentence}` } })
      expect(result.ok, sentence).toBe(false)
      expect(result.queue.some((entry) => entry.code === "ref_unresolved"), sentence).toBe(true)
    }
    enableFlag()
    const mark = await generateDocket({
      ...marked(["P-1", "P-2"]),
      draft: { body: "Relies on P/1 and P/2. The P-9, Street map is annexed." },
    })
    expect(mark.ok).toBe(false)
    expect(mark.queue.some((entry) => entry.detail.includes("P/9"))).toBe(true)
  })

  it("LOW keeps a mark together across a bare return, a line separator, and a blank line", async () => {
    const cited = "Relies on P/1 and P/2."
    for (const sentence of ["The deed P-\r9 is relied on.", "The deed P-\u20289 is relied on.", "P/\n\n9", "P-\n\n9"]) {
      enableFlag()
      const result = await generateDocket({ ...marked(["P-1", "P-2"]), draft: { body: `${cited} ${sentence}` } })
      expect(result.ok, sentence).toBe(false)
      expect(result.queue.some((entry) => entry.detail.includes("P/9")), sentence).toBe(true)
    }
    const letters = "The petitioner relies on Annexures A, B and C."
    for (const sentence of ["ANNEXURE:\n\nD - Bank statement", "A and\n\nD", "A,\n\nD", "A to\n\nD", "A/\n\nD"]) {
      enableFlag()
      const result = await generateDocket({ ...petition, draft: { body: `${letters} ${sentence}` } })
      expect(result.ok, sentence).toBe(false)
      expect(result.queue.some((entry) => entry.detail.includes("D")), sentence).toBe(true)
    }
  })

  it("reads a spaced name or a one-dot path as a mark", async () => {
    for (const sentence of ["Mr. Ali/P-9", "record.file/P-9"]) {
      enableFlag()
      const result = await generateDocket({ ...marked(["P-1", "P-2"]), draft: { body: `Relies on P/1 and P/2. ${sentence}` } })
      expect(result.ok, sentence).toBe(false)
      expect(result.queue.some((entry) => entry.detail.includes("P/9")), sentence).toBe(true)
    }
  })

  it("reads a single letter after See", async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: "The petitioner relies on Annexures A, B and C. See D." },
    })
    expect(result.ok).toBe(false)
    expect(result.queue.some((entry) => entry.detail.includes("D"))).toBe(true)
  })

  it("reads Annexures after See as one citation", async () => {
    await expectGeneration({ ...petition, draft: { body: "See Annexures A, B and C." } }, "See Annexures")
  })

  it("does not treat para A or a parenthesised list marker as Annexure A", async () => {
    const body = "The petitioner relies on Annexures B and C. The petitioner relies on para A of the judgment. The petitioner relies on the following grounds: (a) delay; (b) fraud."
    enableFlag()
    const result = await generateDocket({ ...petition, draft: { body } })
    expect(result.ok).toBe(false)
    expect(result.queue.some((entry) => entry.detail === "body does not refer to A")).toBe(true)
    expect(result.queue.some((entry) => entry.detail.includes("different order"))).toBe(false)
  })

  it("REF-R9-001 refuses a label-shaped follower after a bare annexure head", async () => {
    const cited = "The petitioner relies on Annexures A, B and C."
    const sentences = [
      "See Annexures, viz., D.",
      "See Annexures, viz. D.",
      "See Annexures viz., D.",
      "See Annexures; viz., D.",
      "See Annexure É.",
      "See Annexure ABCD.",
      "See Annexure NO.",
      "See Annexure IN.",
      "See Annexure BY.",
      "See Annexure ON.",
      "See Annex-\n\nure D.",
      "See Annex-\rure D.",
      "See Annex-\u2028ure D.",
      "See Annex-\u2029ure D.",
    ]
    for (const sentence of sentences) {
      enableFlag()
      const result = await generateDocket({ ...petition, draft: { body: `${cited} ${sentence}` } })
      expect(result.ok, JSON.stringify(sentence)).toBe(false)
      expect(result.queue.some((entry) => entry.code === "ref_unresolved"), JSON.stringify(sentence)).toBe(true)
    }
  })

  it("ORDER-R9-001 enforces order when the heading ends at the line break", async () => {
    const letterBodies = [
      "LIST OF ANNEXURES\nThe petitioner relies on Annexure C, then Annexure B and Annexure A.",
      "Index of documents\nAnnexure C is the receipt; Annexure B is the deed; Annexure A is the plaint.",
    ]
    for (const body of letterBodies) {
      enableFlag()
      const result = await generateDocket({ ...petition, draft: { body } })
      expect(result.ok, body).toBe(false)
      expect(result.queue.some((entry) => entry.code === "order_unresolved"), body).toBe(true)
    }
    const third = exhibits.annexures[1]!
    const withThird = {
      ...exhibits,
      annexures: [
        ...exhibits.annexures,
        {
          ...third,
          assignedLabel: "P-3",
          metadata: { ...third.metadata, artifactId: "ex-3", label: "Map", sourceRef: "doc-map" },
        },
      ],
    }
    const markBodies = [
      "EXHIBITS:\nThe witness proved P-1, P-3 and then P-2.",
      "Exhibit: P-1 is the photograph. Exhibit: P-3 is the map. Exhibit: P-2 is the letter.",
    ]
    for (const body of markBodies) {
      enableFlag()
      const result = await generateDocket({ ...withThird, draft: { body } })
      expect(result.ok, body).toBe(false)
      expect(result.queue.some((entry) => entry.code === "order_unresolved"), body).toBe(true)
    }
  })

  it("OVER-R9-001 generates a keyword colon split from its labels by a blank line", async () => {
    await expectGeneration(
      {
        ...petition,
        draft: {
          body: "The petitioner relies on Annexures A, B and C. ANNEXURES:\n\nA - Plaint\n\nB - Notice\n\nC - Vakalatnama",
        },
      },
      "blank line after ANNEXURES",
    )
  })

  it("LOW refuses bare labels after relies on", async () => {
    enableFlag()
    const result = await generateDocket({
      ...petition,
      draft: { body: "The petitioner relies on Annexures A, B and C. The petitioner relies on D and E." },
    })
    expect(result.ok).toBe(false)
    expect(result.queue.some((entry) => entry.detail.includes("D"))).toBe(true)
  })

  it("REF-R10-001 refuses a dropped letter or an abbreviation period after a bare head", async () => {
    const cited = "The petitioner relies on Annexures A, B and C."
    const sentences = [
      "See Annexures filed herewith É.",
      "See Annexures on É.",
      "See Annexures filed herewith É and Ë.",
      "See Annexures on record, cf. D.",
      "See Annexures on record, esp. D.",
      "See Annexures attached hereto, etc. D.",
      "Annexure ABCD is the deed.",
      "Annexure IN is the deed.",
      "Annexure NO is the deed.",
      "Annexure É is the deed.",
    ]
    for (const sentence of sentences) {
      enableFlag()
      const result = await generateDocket({ ...petition, draft: { body: `${cited} ${sentence}` } })
      expect(result.ok, sentence).toBe(false)
      expect(result.queue.some((entry) => entry.code === "ref_unresolved"), sentence).toBe(true)
    }
  })

  it("ORDER-R10-001 enforces order unless the line is exactly a heading", async () => {
    const reversed = "The petitioner relies on Annexure C, then Annexure B and Annexure A."
    const bodies = [
      `LIST OF ANNEXURES ${reversed}`,
      `**LIST OF ANNEXURES**\n${reversed}`,
      `(LIST OF ANNEXURES)\n${reversed}`,
      `"LIST OF ANNEXURES"\n${reversed}`,
      `1 LIST OF ANNEXURES\n${reversed}`,
      `- LIST OF ANNEXURES\n${reversed}`,
      `LIST-OF-ANNEXURES\n${reversed}`,
      `LIST OF\nANNEXURES\n${reversed}`,
      `LIST OF ANNEXURES\u000B${reversed}`,
      `LIST OF ANNEXURES\u000C${reversed}`,
      `LIST OF ANNEXURES\u0085${reversed}`,
      "Index of documents Annexure C is the receipt; Annexure B is the deed; Annexure A is the plaint.",
    ]
    for (const body of bodies) {
      enableFlag()
      const result = await generateDocket({ ...petition, draft: { body } })
      expect(result.ok, JSON.stringify(body)).toBe(false)
      expect(result.queue.some((entry) => entry.code === "order_unresolved"), JSON.stringify(body)).toBe(true)
    }
    const third = exhibits.annexures[1]!
    const withThird = {
      ...exhibits,
      annexures: [
        ...exhibits.annexures,
        { ...third, assignedLabel: "P-3", metadata: { ...third.metadata, artifactId: "ex-3", label: "Map", sourceRef: "doc-map" } },
      ],
    }
    enableFlag()
    const marks = await generateDocket({
      ...withThird,
      draft: { body: "Exhibit: P-1. Exhibit: P-3. Exhibit: P-2." },
    })
    expect(marks.ok).toBe(false)
    expect(marks.queue.some((entry) => entry.code === "order_unresolved")).toBe(true)
    enableFlag()
    const split = await generateDocket({
      ...withThird,
      draft: { body: "EXHIBITS:\nP-1 is the deed. P-3 is the map. P-2 is the receipt." },
    })
    expect(split.ok).toBe(false)
    expect(split.queue.some((entry) => entry.code === "order_unresolved")).toBe(true)
  })

  it("OVER-R9-001 generates the brief index with a blank line and an in-order body", async () => {
    await expectGeneration(
      {
        ...petition,
        draft: {
          body: "ANNEXURES:\n\nA - Plaint\nB - Deed\nC - Receipt\n\nThe petitioner relies on Annexure A, then Annexure B and Annexure C.",
        },
      },
      "ME OVER-R9-001",
    )
  })

  it("OVER-R10-001 generates a head followed only by stopwords", async () => {
    const cited = "The petitioner relies on Annexures A, B and C."
    for (const sentence of [
      "The petitioner relies on Annexures filed herewith.",
      "The petitioner relies on annexures on record.",
    ]) {
      await expectGeneration({ ...petition, draft: { body: `${cited} ${sentence}` } }, sentence)
    }
  })

  it("LOW refuses relies upon and see also before a bare letter", async () => {
    const cited = "The petitioner relies on Annexures A, B and C."
    for (const sentence of ["The petitioner relies upon D.", "See also D."]) {
      enableFlag()
      const result = await generateDocket({ ...petition, draft: { body: `${cited} ${sentence}` } })
      expect(result.ok, sentence).toBe(false)
      expect(result.queue.some((entry) => entry.detail.includes("D")), sentence).toBe(true)
    }
  })

  it("TEST-R10 keeps heading labels out of order and reads viz and abbreviation tails", async () => {
    const reversed = "The petitioner relies on Annexure C, then Annexure B and Annexure A."
    for (const body of [`LIST OF ANNEXURES: A, B, C.\n${reversed}`, `LIST OF ANNEXURES: A, B, C.\u2029${reversed}`]) {
      enableFlag()
      const result = await generateDocket({ ...petition, draft: { body } })
      expect(result.ok, JSON.stringify(body)).toBe(false)
      expect(result.queue.some((entry) => entry.code === "order_unresolved"), JSON.stringify(body)).toBe(true)
    }
    const cited = "The petitioner relies on Annexures A, B and C."
    for (const sentence of [
      "Annexures, viz., D and E are filed.",
      "annexures, viz., d and e are filed.",
      "See Annexures filed herewith, i.e. D.",
      "See Annexures filed herewith, i.e., D and E.",
      "See Annexures filed herewith, i.",
      "See Annexures filed herewith, viz.",
      "The petitioner relies on Annexures, viz., D.",
    ]) {
      enableFlag()
      const result = await generateDocket({ ...petition, draft: { body: `${cited} ${sentence}` } })
      expect(result.ok, sentence).toBe(false)
      expect(result.queue.some((entry) => entry.code === "ref_unresolved"), sentence).toBe(true)
    }
    enableFlag()
    const colonLabel = await generateDocket({ ...petition, draft: { body: "ANNEXURES:\nD." } })
    expect(colonLabel.queue.some((entry) => entry.detail.includes("D"))).toBe(true)
    await expectGeneration(
      {
        ...exhibits,
        draft: { body: "LIST OF DOCUMENTS: P-2, P-1. The witness proved P-1 and then P-2." },
      },
      "heading marks stay out of the order",
    )
    await expectGeneration(
      {
        ...petition,
        draft: { body: "LIST OF DOCUMENTS: See C, B and A." },
      },
      "heading opener stays out of the order",
    )
  })

  it("keeps the three-dot refusal after NFKC and does not keep a U+2026 branch", () => {
    const source = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../layers/L5_5_DocketGenerator/references.ts"),
      "utf8",
    )
    expect(source).not.toContain("\\u2026")
    expect(source).not.toContain("\u2026")
    expect("A\u2026D".normalize("NFKC")).toBe("A...D")
  })
})

describe("L5.5 layer boundary", () => {
  it("does not import core services or register a route", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../layers/L5_5_DocketGenerator")
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.(ts|tsx)$/.test(name)) files.push(full)
      }
    }
    walk(root)
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n")
    const imports = source.split("\n").filter((line) => line.trimStart().startsWith("import"))
    expect(imports.join("\n")).not.toMatch(/@\/platform\/|@\/services\/|@\/app\/|firebase|postgres|pg\b/)
    expect(source).not.toMatch(/\bfetch\s*\(/)
    expect(source).not.toMatch(/export (async )?function (GET|POST|PUT|PATCH)/)
    const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8")) as { core_edits: boolean; default_enabled: boolean; routes: unknown[] }
    expect(manifest.core_edits).toBe(false)
    expect(manifest.default_enabled).toBe(false)
    expect(manifest.routes).toEqual([])
    const migration = readFileSync(path.join(root, "migration.sql"), "utf8")
    expect(migration).not.toMatch(/CREATE|ALTER|INSERT|DROP/i)
    const pkg = JSON.parse(readFileSync(path.resolve(root, "../../package.json"), "utf8")) as {
      dependencies: Record<string, string>
    }
    expect(pkg.dependencies["pdf-lib"]).toBe("1.17.1")
    expect(pkg.dependencies.docx).toBe("9.15.4")
    expect(pkg.dependencies.fflate).toBe("0.8.3")
    for (const name of ["pdf-lib", "docx", "fflate"]) {
      const license = JSON.parse(readFileSync(path.resolve(root, `../../node_modules/${name}/package.json`), "utf8")) as { license?: string }
      expect(license.license).toBe("MIT")
    }
  })
})
