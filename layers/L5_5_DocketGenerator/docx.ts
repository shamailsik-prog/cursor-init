import {
  AlignmentType,
  Document,
  LineRuleType,
  Packer,
  PageBreak,
  Paragraph,
  TextRun,
} from "docx"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { FIXED_DOCKET_TIMESTAMP } from "@/layers/L5_5_DocketGenerator/pdf"
import type { DocketPlan, PlanLine } from "@/layers/L5_5_DocketGenerator/layout"

const FIXED_DATE = new Date(FIXED_DOCKET_TIMESTAMP)

function alignment(line: PlanLine): (typeof AlignmentType)[keyof typeof AlignmentType] {
  if (line.align === "center") return AlignmentType.CENTER
  if (line.align === "right") return AlignmentType.RIGHT
  return AlignmentType.LEFT
}

function paragraph(line: PlanLine): Paragraph {
  return new Paragraph({
    alignment: alignment(line),
    spacing: { before: 0, after: 0, line: 360, lineRule: LineRuleType.AUTO },
    children: [
      new TextRun({
        text: line.text.length > 0 ? line.text : " ",
        bold: line.bold,
        font: "Times New Roman",
        size: line.size * 2,
      }),
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
    frozen[name] = [data, { level: 9, mtime: FIXED_DATE }]
  }
  return zipSync(frozen)
}

export async function buildDocx(plan: DocketPlan): Promise<Uint8Array> {
  const children: Paragraph[] = []
  plan.pages.forEach((page, index) => {
    if (page.lines.length === 0) {
      children.push(paragraph({ text: " ", size: 12, bold: false, align: "left" }))
    } else {
      for (const line of page.lines) children.push(paragraph(line))
    }
    if (index < plan.pages.length - 1) {
      children.push(new Paragraph({ children: [new PageBreak()] }))
    }
  })
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
          paragraph: { spacing: { before: 0, after: 0, line: 360, lineRule: LineRuleType.AUTO } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: Math.round(plan.pageSize.width * 20),
              height: Math.round(plan.pageSize.height * 20),
            },
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        children,
      },
    ],
  })
  const raw = await Packer.toBuffer(doc)
  return freezeDocx(new Uint8Array(raw))
}
