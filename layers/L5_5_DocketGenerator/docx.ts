import {
  AlignmentType,
  Document,
  LineRuleType,
  Packer,
  PageNumber,
  Paragraph,
  SectionType,
  TextRun,
} from "docx"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import type { DocketPlan, PlanLine } from "@/layers/L5_5_DocketGenerator/layout"

/** DOS zip time stores local calendar fields. Local midnight is those fields in every time zone. */
function fixedZipMtime(): Date {
  return new Date(2026, 0, 1, 0, 0, 0)
}

function alignment(line: PlanLine): (typeof AlignmentType)[keyof typeof AlignmentType] {
  if (line.align === "center") return AlignmentType.CENTER
  if (line.align === "right") return AlignmentType.RIGHT
  return AlignmentType.LEFT
}

function lineTwips(line: PlanLine, previous: PlanLine | null): number {
  if (!previous) return line.size * 20
  return Math.round(previous.size * 1.5 * 20)
}

function paragraph(line: PlanLine, previous: PlanLine | null, pageNumber: boolean): Paragraph {
  const spacing = { before: 0, after: 0, line: lineTwips(line, previous), lineRule: LineRuleType.EXACT }
  const run = {
    bold: line.bold,
    font: "Times New Roman",
    size: line.size * 2,
  }
  return new Paragraph({
    alignment: alignment(line),
    spacing,
    widowControl: false,
    children: [
      pageNumber
        ? new TextRun({ ...run, children: [PageNumber.CURRENT] })
        : new TextRun({ ...run, text: line.text.length > 0 ? line.text : " " }),
    ],
  })
}

function paragraphText(lines: readonly PlanLine[]): string {
  return lines
    .map((line) => line.text.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0)
    .join(" ")
}

/** One reflowing paragraph per source paragraph. Line breaks are not written into the file. */
function flowAlignment(line: PlanLine): (typeof AlignmentType)[keyof typeof AlignmentType] {
  if (line.align === "left") return AlignmentType.BOTH
  return alignment(line)
}

function flowParagraph(lines: readonly PlanLine[]): Paragraph {
  const first = lines[0]
  const text = first ? paragraphText(lines) : ""
  const size = first?.size ?? 12
  return new Paragraph({
    alignment: first ? flowAlignment(first) : AlignmentType.LEFT,
    spacing: { before: 0, after: 0, line: Math.round(size * 1.5 * 20), lineRule: LineRuleType.EXACT },
    widowControl: false,
    children: [
      new TextRun({
        bold: first?.bold ?? false,
        font: "Times New Roman",
        size: size * 2,
        text: text.length > 0 ? text : " ",
      }),
    ],
  })
}

function pageParagraphs(lines: readonly PlanLine[]): Paragraph[] {
  if (lines.length === 0) return [paragraph({ text: " ", size: 12, bold: false, align: "left", paragraphId: -1 }, null, false)]
  const children: Paragraph[] = []
  let index = 0
  const first = lines[0]
  if (first && first.align === "right" && /^\d+$/.test(first.text)) {
    children.push(paragraph(first, null, true))
    index = 1
  }
  while (index < lines.length) {
    const paragraphId = lines[index]?.paragraphId
    const group: PlanLine[] = []
    while (index < lines.length && lines[index]?.paragraphId === paragraphId) {
      const line = lines[index]
      if (line) group.push(line)
      index += 1
    }
    if (group.length > 0) children.push(flowParagraph(group))
  }
  return children
}

const FIXED_CORE_TIMESTAMP = "2026-01-01T00:00:00Z"

/** Created and modified stamps in core properties. Filing text is not rewritten. */
function freezeCoreTimestamps(xml: string): string {
  return xml.replace(
    /(<(?:dcterms:created|dcterms:modified)\b[^>]*>)[^<]*/g,
    `$1${FIXED_CORE_TIMESTAMP}`,
  )
}

function freezeDocx(bytes: Uint8Array): Uint8Array {
  const files = unzipSync(bytes)
  const frozen: Record<string, [Uint8Array, { level: 9; mtime: Date }]> = {}
  for (const name of Object.keys(files).sort()) {
    let data = files[name]
    if (!data) continue
    if (name === "docProps/core.xml") data = strToU8(freezeCoreTimestamps(strFromU8(data)))
    frozen[name] = [data, { level: 9, mtime: fixedZipMtime() }]
  }
  return zipSync(frozen)
}

export async function buildDocx(plan: DocketPlan): Promise<Uint8Array> {
  const width = Math.round(plan.pageSize.width * 20)
  const height = Math.round(plan.pageSize.height * 20)
  const doc = new Document({
    creator: "Sikander AI",
    title: "Court-format docket",
    description: "L5.5 annexure docket",
    lastModifiedBy: "Sikander AI",
    revision: 1,
    styles: {
      default: {
        document: {
          run: { font: "Times New Roman", size: 24 },
          paragraph: { spacing: { before: 0, after: 0, line: 360, lineRule: LineRuleType.EXACT } },
        },
      },
    },
    sections: plan.pages.map((page) => ({
      properties: {
        type: SectionType.NEXT_PAGE,
        page: {
          size: { width, height },
          margin: { top: 2160, right: 1440, bottom: 2160, left: 1440, header: 720, footer: 720 },
        },
      },
      children: pageParagraphs(page.lines),
    })),
  })
  const raw = await Packer.toBuffer(doc)
  return freezeDocx(new Uint8Array(raw))
}
