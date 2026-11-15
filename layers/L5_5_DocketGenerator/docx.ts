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
    wordWrap: false,
    widowControl: false,
    children: [
      pageNumber
        ? new TextRun({ ...run, children: [PageNumber.CURRENT] })
        : new TextRun({ ...run, text: line.text.length > 0 ? line.text : " " }),
    ],
  })
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
      children:
        page.lines.length === 0
          ? [paragraph({ text: " ", size: 12, bold: false, align: "left" }, null, false)]
          : page.lines.map((line, index) =>
              paragraph(line, index === 0 ? null : (page.lines[index - 1] ?? null), index === 0 && line.align === "right"),
            ),
    })),
  })
  const raw = await Packer.toBuffer(doc)
  return freezeDocx(new Uint8Array(raw))
}
