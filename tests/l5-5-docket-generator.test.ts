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
  const chunks = document.split(/<w:br[^>]*w:type="page"[^/]*\/>/)
  const texts = chunks.map((chunk) =>
    [...chunk.matchAll(/<w:t(?:[^>]*)>([^<]*)<\/w:t>/g)].map((match) => match[1] ?? "").join(""),
  )
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
    const result = await generateDocket(application)
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
