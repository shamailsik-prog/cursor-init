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
    for (const phrase of ["Main Street. P/3", "same block. P/3", "the form, P/3"]) {
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
    const bin = path.join(root, "node_modules/.bin/vite-node")
    const config = path.join(root, "vitest.config.ts")
    const render = (tz: string) => {
      const out = path.join("/tmp", `q12a-docket-${tz.replace(/\//g, "_")}.docx`)
      const run = spawnSync(bin, ["--config", config, probe], {
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
